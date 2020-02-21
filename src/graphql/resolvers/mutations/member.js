import debug from 'debug';

import memberStore from '../../../dataSources/cloudFirestore/member';

const dlog = debug('that:api:members:mutation');

export const fieldResolvers = {
  MemberMutation: {
    update: async (
      { memberId },
      { profile },
      {
        dataSources: {
          firestore,
          logger,
          events: { userEvents },
        },
      },
    ) => {
      dlog(`MembersMutation:update for ${memberId}, %o`, profile);

      const updatedMember = await memberStore(firestore, logger).update({
        memberId,
        profile,
      });

      userEvents.emit('accountUpdated', updatedMember);

      return updatedMember;
    },
  },
};
