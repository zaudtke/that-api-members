import debug from 'debug';
import * as Sentry from '@sentry/node';
import { dataSources, utility } from '@thatconference/api';

const dlog = debug('that:api:members:datasources:members');
const slugStore = dataSources.cloudFirestore.slug;
const { dateForge } = utility.firestoreDateForge;
const memberDateForge = utility.firestoreDateForge.members;

function scrubProfile(profile, isNew) {
  const scrubbedProfile = profile;

  const modifiedAtDate = new Date();

  if (isNew) {
    scrubbedProfile.createdAt = modifiedAtDate;
  }
  scrubbedProfile.lastUpdatedAt = modifiedAtDate;

  if (!scrubbedProfile.interests) scrubbedProfile.interests = [];

  return scrubbedProfile;
}

const member = dbInstance => {
  const collectionName = 'members';
  const membersCol = dbInstance.collection(collectionName);

  // is deprecated
  async function isProfileSlugTakenLocal(slug) {
    dlog('db isProfileSlugUnique %o', slug);

    const requestedSlug = slug.toLowerCase();

    const docSnapshot = await membersCol
      .where('profileSlug', '==', requestedSlug)
      .get();

    return docSnapshot.size !== 0;
  }

  function isProfileSlugTaken(slug) {
    dlog('isProfileSlugUnique', slug);
    return slugStore(dbInstance).isSlugTaken(slug);
  }

  // is deprecated
  async function createLocal({ user, profile }) {
    dlog('created called for user %o, with profile %o', user, profile);
    const docRef = membersCol.doc(user.sub);

    const modifiedProfile = scrubProfile(profile, true);
    dlog('modified profile %o', modifiedProfile);

    const isSlugTaken = await isProfileSlugTaken(modifiedProfile.profileSlug);
    if (isSlugTaken) throw new Error('profile slug is taken');

    await docRef.set(modifiedProfile, { merge: true });
    const updatedDoc = await docRef.get();

    return {
      id: docRef.id,
      ...updatedDoc.data(),
    };
  }

  async function create({ user, profile }) {
    dlog('create called, user %o with profile %o', user, profile);
    const docRef = membersCol.doc(user.sub);
    const modifiedProfile = scrubProfile(profile, true);
    dlog('modified profile %o', modifiedProfile);

    const isSlugTaken = await isProfileSlugTaken(modifiedProfile.profileSlug);
    if (isSlugTaken)
      throw new Error(
        'profile slug is taken it cannot be used to create a new profile',
      );

    const slugDoc = slugStore(dbInstance).makeSlugDoc({
      slugName: modifiedProfile.profileSlug,
      type: 'member',
      referenceId: user.sub,
    });
    slugDoc.createdAt = modifiedProfile.createdAt;
    const slugDocRef = slugStore(dbInstance).getSlugDocRef(
      modifiedProfile.profileSlug,
    );

    const writeBatch = dbInstance.batch();
    writeBatch.create(docRef, modifiedProfile);
    writeBatch.create(slugDocRef, slugDoc);
    let writeResult;
    try {
      writeResult = await writeBatch.commit();
    } catch (err) {
      dlog('failed batch write member profile and slug');
      Sentry.withScope(scope => {
        scope.setLevel('error');
        scope.setContext(
          'batch write of member profile and slug failed',
          { docRef, modifiedProfile },
          { slugDocRef, slugDoc },
        );
        Sentry.captureException(err);
      });
      throw new Error('failed batch write member profile and slug');
    }
    dlog('writeResult @O', writeResult);
    const out = {
      id: docRef.id,
      ...modifiedProfile,
    };

    return memberDateForge(out);
  }

  async function findPublicById(id) {
    dlog('findPublicById %s', id);
    const docRef = await membersCol.doc(id).get();
    let result = null;
    if (docRef.exists) {
      if (docRef.get('canFeature') && !docRef.get('isDeactivated')) {
        const pl = docRef.get('profileLinks');
        result = {
          id: docRef.id,
          ...docRef.data(),
          profileLinks: pl ? pl.filter(p => p.isPublic) : [],
        };
        result = memberDateForge(result);
      }
    }

    return result;
  }

  async function findMember(slug) {
    const docSnapshot = await membersCol
      .where('profileSlug', '==', slug.toLowerCase())
      .where('canFeature', '==', true)
      .where('isDeactivated', '==', false)
      .get();

    let results = null;

    if (docSnapshot.size === 1) {
      const profile = docSnapshot.docs[0].data();
      profile.id = docSnapshot.docs[0].id;
      profile.profileLinks = profile.profileLinks.filter(
        pl => pl.isPublic === true,
      );

      results = memberDateForge(profile);
    }

    return results;
  }

  async function findMe(memberId) {
    const docRef = await dbInstance.doc(`${collectionName}/${memberId}`).get();

    let result = null;

    if (docRef.exists) {
      result = {
        id: docRef.id,
        ...docRef.data(),
      };
      result = memberDateForge(result);
    }

    return result;
  }

  async function findIdFromSlug(slug) {
    dlog('findIdFromSlug %s', slug);
    const { size, docs } = await membersCol
      .where('profileSlug', '==', slug)
      .select()
      .get();

    let result = null;
    if (size === 1) {
      const [doc] = docs;
      result = {
        id: doc.id,
        profileSlug: slug,
      };
    } else if (size > 1)
      throw new Error('Slug associated with mupliple members. %s', slug);

    return result;
  }

  async function getSlug(id) {
    dlog('getSlug from id %s', id);
    const docRef = await membersCol.doc(id).get();
    let result = null;
    if (docRef.exists) {
      result = {
        id: docRef.id,
        profileSlug: docRef.get('profileSlug'),
      };
    }

    return result;
  }

  async function batchFindMembers(memberIds) {
    dlog('batchFindMembers %o', memberIds);

    const docRefs = memberIds.map(id =>
      dbInstance.doc(`${collectionName}/${id}`),
    );

    return Promise.all(docRefs.map(d => d.get())).then(res =>
      res.map(r => {
        const result = {
          id: r.id,
          ...r.data(),
        };
        return memberDateForge(result);
      }),
    );
  }

  async function fetchPublicMembersByCreated(limit, startAfter) {
    // Start after is poorly named, it is the cursor for the paged request
    dlog('fetchPublicMember: limit: %d start after: %s', limit, startAfter);
    const truelimit = Math.min(limit || 20, 100);
    let query = membersCol
      .where('canFeature', '==', true)
      .where('isDeactivated', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(truelimit);

    if (startAfter) {
      const scursor = Buffer.from(startAfter, 'base64').toString('utf8');
      const { curStartAfter } = JSON.parse(scursor);
      if (!curStartAfter)
        throw new Error('Invlid cursor value provied for startAfter');

      query = query.startAfter(new Date(curStartAfter));
    }
    const qrySnapshot = await query.get();

    dlog('fetchPublicMembersByCreated query size? %s', qrySnapshot.size);
    if (!qrySnapshot.size || qrySnapshot.size === 0) return null;

    const memberSet = qrySnapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    let cursor = '';
    const lastCreatedAt = memberSet[memberSet.length - 1].createdAt;
    if (lastCreatedAt) {
      const cpieces = JSON.stringify({
        curStartAfter: dateForge(lastCreatedAt),
      });
      cursor = Buffer.from(cpieces, 'utf8').toString('base64');
    }

    return {
      cursor,
      members: memberSet.map(m => memberDateForge(m)),
    };
  }

  async function fetchPublicMembersByFirstName(limit, startAfter) {
    dlog(
      'fetchPublicMembersByLastName: limit: %d, startAfter: %s',
      limit,
      startAfter,
    );
    const truelimit = Math.min(limit || 20, 100);
    let query = membersCol
      .where('canFeature', '==', true)
      .where('isDeactivated', '==', false)
      .orderBy('firstName', 'asc')
      .orderBy('createdAt', 'asc')
      .limit(truelimit);

    if (startAfter) {
      // decode base64, split on separator ||
      const scursor = Buffer.from(startAfter, 'base64')
        .toString('utf8')
        .split('||');
      dlog('decoded cursor: %s, %s', scursor[0], scursor[1]);
      if (!scursor[1]) return null; // invalid cursor, return no records

      query = query.startAfter(scursor[0], scursor[1] || '');
    }
    const qrySnapshot = await query.get();
    dlog('fetchPublicMembersByFirstName query size? %s', qrySnapshot.size);
    if (!qrySnapshot.size || qrySnapshot.size === 0) return null;

    const memberSet = qrySnapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
    }));

    // base64 encode new composite cursor
    const cpieces = `${memberSet[memberSet.length - 1].firstName}||${
      memberSet[memberSet.length - 1].createdAt
    }`;
    const cursor = Buffer.from(cpieces, 'utf8').toString('base64');
    dlog('encoded cursor %s', cursor);

    return {
      cursor,
      members: memberSet.map(m => memberDateForge(m)),
    };
  }

  async function update({ memberId, profile }) {
    dlog('db update called');

    const docRef = dbInstance.doc(`${collectionName}/${memberId}`);

    const modifiedProfile = scrubProfile(profile);
    await docRef.update(modifiedProfile);

    const updatedDoc = await docRef.get();
    const out = {
      id: updatedDoc.id,
      ...updatedDoc.data(),
    };

    return memberDateForge(out);
  }

  function remove(memberId) {
    dlog('remove');
    const documentRef = dbInstance.doc(`${collectionName}/${memberId}`);

    return documentRef.delete().then(res => memberId);
  }

  return {
    isProfileSlugTaken,
    create,
    findMember,
    findPublicById,
    findMe,
    findIdFromSlug,
    getSlug,
    batchFindMembers,
    fetchPublicMembersByCreated,
    fetchPublicMembersByFirstName,
    update,
    remove,
  };
};

export default member;
