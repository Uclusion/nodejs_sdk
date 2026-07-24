import assert from 'assert';
import { loginUserToAccount, loginUserToIdentity, loginUserToMarketInvite } from '../src/utils.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (adminConfiguration) {
  describe('#test comment conversions', () => {
    let adminClient;
    let marketId;
    let jobAId;
    let jobBId;

    before(async function () {
      this.timeout(300000);
      if (!adminConfiguration.idToken) {
        // The full suite bootstraps this in usersTest; keep this file standalone.
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountClient = await loginUserToAccount(adminConfiguration);
      const result = await accountClient.markets.createMarket({ name: 'Conversions', market_type: 'PLANNING' });
      marketId = result.market.id;
      adminClient = await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const jobA = await adminClient.investibles.create({ name: 'Conversions job A',
        description: 'First job for conversion tests', groupId: marketId });
      jobAId = jobA.investible.id;
      const jobB = await adminClient.investibles.create({ name: 'Conversions job B',
        description: 'Second job for conversion tests', groupId: marketId });
      jobBId = jobB.investible.id;
    });

    // Creates a root comment with a reply thread 3 deep hanging off it
    async function createThread(investibleId, commentType, notificationType) {
      const root = await adminClient.investibles.createComment(investibleId, marketId,
        `${commentType} root to convert`, null, commentType, null, null, notificationType);
      const reply = await adminClient.investibles.createComment(investibleId, marketId, 'first level reply',
        root.id);
      const childReply = await adminClient.investibles.createComment(investibleId, marketId, 'second level reply',
        reply.id);
      const grandChildReply = await adminClient.investibles.createComment(investibleId, marketId,
        'third level reply', childReply.id);
      return { root, reply, childReply, grandChildReply };
    }

    function threadReplyIds(thread) {
      return [thread.reply.id, thread.childReply.id, thread.grandChildReply.id];
    }

    async function fetchThread(thread) {
      const signatures = Object.values(thread).map((comment) => ({ id: comment.id, version: 1 }));
      return adminClient.investibles.getMarketComments(signatures);
    }

    // Reply cleanup cascades level by level async, so poll until the thread reaches the expected
    // state or time runs out and the caller's asserts report what is still wrong
    async function pollThread(thread, isCleanedUp) {
      let comments = await fetchThread(thread);
      for (let i = 0; i < 20 && !isCleanedUp(comments); i += 1) {
        await sleep(3000);
        comments = await fetchThread(thread);
      }
      return comments;
    }

    function getComment(comments, id) {
      return comments.find((comment) => comment.id === id) || {};
    }

    function repliesCleanedUp(comments, replyIds, expectedRootId, expectedInvestibleId) {
      return replyIds.every((id) => {
        const comment = getComment(comments, id);
        return comment.root_comment_id === expectedRootId &&
          (expectedInvestibleId ? comment.investible_id === expectedInvestibleId : !comment.investible_id);
      });
    }

    function checkReply(comments, id, expectedRootId, expectedInvestibleId, label) {
      const comment = getComment(comments, id);
      assert(comment.id, `${label} should still exist`);
      assert(comment.comment_type === 'REPLY', `${label} comment_type should stay REPLY but is ${comment.comment_type}`);
      assert(comment.root_comment_id === expectedRootId,
        `${label} root_comment_id should be ${expectedRootId} but is ${comment.root_comment_id}`);
      if (expectedInvestibleId) {
        assert(comment.investible_id === expectedInvestibleId,
          `${label} investible_id should be ${expectedInvestibleId} but is ${comment.investible_id}`);
      } else {
        assert(!comment.investible_id, `${label} investible_id should be cleared but is ${comment.investible_id}`);
      }
      assert(comment.group_id === marketId, `${label} group_id should be ${marketId} but is ${comment.group_id}`);
    }

    function checkThreadReplies(comments, thread, expectedRootId, expectedInvestibleId) {
      checkReply(comments, thread.reply.id, expectedRootId, expectedInvestibleId, 'reply');
      checkReply(comments, thread.childReply.id, expectedRootId, expectedInvestibleId, 'child reply');
      checkReply(comments, thread.grandChildReply.id, expectedRootId, expectedInvestibleId, 'grandchild reply');
    }

    it('should convert task to bug', async () => {
      const thread = await createThread(jobAId, 'TODO');
      await adminClient.investibles.alterComment(thread.root.id, 'YELLOW');
      const comments = await pollThread(thread,
        (fetched) => repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, undefined));
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `bug comment_type should stay TODO but is ${root.comment_type}`);
      assert(!root.investible_id, `bug investible_id should be cleared but is ${root.investible_id}`);
      assert(root.notification_type === 'YELLOW',
        `bug notification_type should be YELLOW but is ${root.notification_type}`);
      checkThreadReplies(comments, thread, thread.root.id, undefined);
    }).timeout(240000);

    it('should move task to different job', async () => {
      const thread = await createThread(jobAId, 'TODO');
      await adminClient.investibles.moveComments(jobBId, [thread.root.id]);
      const comments = await pollThread(thread,
        (fetched) => repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, jobBId));
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `task comment_type should stay TODO but is ${root.comment_type}`);
      assert(root.investible_id === jobBId, `task investible_id should be ${jobBId} but is ${root.investible_id}`);
      checkThreadReplies(comments, thread, thread.root.id, jobBId);
    }).timeout(240000);

    it('should convert bug to task', async () => {
      const thread = await createThread(null, 'TODO', 'YELLOW');
      await adminClient.investibles.moveComments(jobAId, [thread.root.id]);
      const comments = await pollThread(thread,
        (fetched) => repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, jobAId));
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `task comment_type should stay TODO but is ${root.comment_type}`);
      assert(root.investible_id === jobAId, `task investible_id should be ${jobAId} but is ${root.investible_id}`);
      checkThreadReplies(comments, thread, thread.root.id, jobAId);
    }).timeout(240000);

    it('should convert reply with children and grandchildren in job to task', async () => {
      const thread = await createThread(jobAId, 'TODO');
      await adminClient.investibles.updateComment(thread.reply.id, undefined, undefined, undefined, undefined,
        'TODO');
      const descendantIds = [thread.childReply.id, thread.grandChildReply.id];
      // Per Q-all-239 the promoted comment is its own root, so root_comment_id may be absent or its own id
      const promotedRootOk = (promoted) => !promoted.root_comment_id ||
        promoted.root_comment_id === thread.reply.id;
      const comments = await pollThread(thread, (fetched) => {
        const promoted = getComment(fetched, thread.reply.id);
        return promoted.comment_type === 'TODO' && !promoted.reply_id && promotedRootOk(promoted) &&
          repliesCleanedUp(fetched, descendantIds, thread.reply.id, jobAId);
      });
      const promoted = getComment(comments, thread.reply.id);
      assert(promoted.comment_type === 'TODO',
        `promoted reply comment_type should be TODO but is ${promoted.comment_type}`);
      assert(!promoted.reply_id, `promoted reply reply_id should be cleared but is ${promoted.reply_id}`);
      assert(promotedRootOk(promoted),
        `promoted reply root_comment_id should be absent or its own id but is ${promoted.root_comment_id}`);
      assert(promoted.investible_id === jobAId,
        `promoted reply investible_id should be ${jobAId} but is ${promoted.investible_id}`);
      checkReply(comments, thread.childReply.id, thread.reply.id, jobAId, 'child reply');
      const childReply = getComment(comments, thread.childReply.id);
      assert(childReply.reply_id === thread.reply.id,
        `child reply reply_id should stay ${thread.reply.id} but is ${childReply.reply_id}`);
      checkReply(comments, thread.grandChildReply.id, thread.reply.id, jobAId, 'grandchild reply');
      const grandChildReply = getComment(comments, thread.grandChildReply.id);
      assert(grandChildReply.reply_id === thread.childReply.id,
        `grandchild reply reply_id should stay ${thread.childReply.id} but is ${grandChildReply.reply_id}`);
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO' && root.investible_id === jobAId,
        'original task should be untouched by promoting its reply');
    }).timeout(240000);

    it('should convert suggestion in job to bug', async () => {
      const thread = await createThread(jobAId, 'SUGGEST');
      await adminClient.investibles.alterComment(thread.root.id, 'RED');
      const comments = await pollThread(thread, (fetched) => {
        const root = getComment(fetched, thread.root.id);
        return root.comment_type === 'TODO' &&
          repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, undefined);
      });
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `bug comment_type should be TODO but is ${root.comment_type}`);
      assert(!root.investible_id, `bug investible_id should be cleared but is ${root.investible_id}`);
      assert(root.notification_type === 'RED', `bug notification_type should be RED but is ${root.notification_type}`);
      checkThreadReplies(comments, thread, thread.root.id, undefined);
    }).timeout(240000);

    it('should convert suggestion in job to task', async () => {
      const thread = await createThread(jobAId, 'SUGGEST');
      await adminClient.investibles.updateComment(thread.root.id, undefined, undefined, undefined, undefined,
        'TODO');
      const comments = await pollThread(thread, (fetched) => {
        const root = getComment(fetched, thread.root.id);
        return root.comment_type === 'TODO' &&
          repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, jobAId);
      });
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `task comment_type should be TODO but is ${root.comment_type}`);
      assert(root.investible_id === jobAId, `task investible_id should stay ${jobAId} but is ${root.investible_id}`);
      checkThreadReplies(comments, thread, thread.root.id, jobAId);
    }).timeout(240000);

    it('should convert suggestion at view level to bug', async () => {
      const thread = await createThread(null, 'SUGGEST');
      await adminClient.investibles.alterComment(thread.root.id, 'BLUE');
      const comments = await pollThread(thread, (fetched) => {
        const root = getComment(fetched, thread.root.id);
        return root.comment_type === 'TODO' &&
          repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, undefined);
      });
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `bug comment_type should be TODO but is ${root.comment_type}`);
      assert(!root.investible_id, `bug investible_id should stay cleared but is ${root.investible_id}`);
      assert(root.notification_type === 'BLUE',
        `bug notification_type should be BLUE but is ${root.notification_type}`);
      checkThreadReplies(comments, thread, thread.root.id, undefined);
    }).timeout(240000);

    it('should convert suggestion at view level to task', async () => {
      const thread = await createThread(null, 'SUGGEST');
      await adminClient.investibles.moveComments(jobBId, [thread.root.id], undefined, [thread.root.id]);
      const comments = await pollThread(thread, (fetched) => {
        const root = getComment(fetched, thread.root.id);
        return root.comment_type === 'TODO' &&
          repliesCleanedUp(fetched, threadReplyIds(thread), thread.root.id, jobBId);
      });
      const root = getComment(comments, thread.root.id);
      assert(root.comment_type === 'TODO', `task comment_type should be TODO but is ${root.comment_type}`);
      assert(root.investible_id === jobBId, `task investible_id should be ${jobBId} but is ${root.investible_id}`);
      checkThreadReplies(comments, thread, thread.root.id, jobBId);
    }).timeout(240000);
  });
};
