import assert from 'assert';
import {loginUserToAccount, loginUserToAccountAndGetToken, loginUserToMarket, getMessages,
    loginUserToMarketInvite} from "../src/utils.js";
import {mcpCall, mcpLogin, pollFor} from "./commonTestFunctions.js";

export default function (adminConfiguration, userConfiguration) {

    describe('#doPlanningNotifications', () => {
        it('should do persistent Planning notifications without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let userId;
            let userExternalId;
            let adminId;
            let adminExternalId;
            let createdMarketId;
            let globalInvestibleId;
            let marketInvestibleId;
            let createdMarketInvite;
            let globalInvestibleTicketCode;
            let questionCommentId;
            let adminMentionCapabilityVersion;
            let todoCommentId;
            let reportCommentId;
            let globalStages;
            let acceptedStage;
            let resolvedStage;
            let inApprovalStage;
            let requiresInputStage;
            const pollForStage = async (stageId) => {
                const investibles = await pollFor(
                    () => adminClient.markets.getMarketInvestibles([
                        {investible: {id: globalInvestibleId, version: 1},
                            market_infos: [{id: marketInvestibleId, version: 1}]}
                    ]),
                    (fetched) => {
                        const marketInfo = fetched[0] && fetched[0].market_infos.find((info) =>
                            info.market_id === createdMarketId);
                        return Boolean(marketInfo && marketInfo.stage === stageId);
                    });
                const marketInfo = investibles[0] && investibles[0].market_infos.find((info) =>
                    info.market_id === createdMarketId);
                assert(marketInfo && marketInfo.stage === stageId,
                    `Market investible should reach stage ${stageId}`);
                return investibles;
            };
            await promise.then((client) => {
                const marketOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A'
                };
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                globalStages = response.stages;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                adminExternalId = user.external_id;
                return adminClient.investibles.create({
                    groupId: createdMarketId,
                    name: 'A test story', description: 'See if notifications work.',
                    assignments: [adminId]});
            }).then((investible) => {
                globalInvestibleId = investible.investible.id;
                marketInvestibleId = investible.market_infos[0].id;
                const marketInfo = investible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                globalInvestibleTicketCode = marketInfo.ticket_code;
                assert(globalInvestibleTicketCode,
                    `Planning job ticket code missing for ${globalInvestibleId}`);
                assert(marketInfo.accepted, 'Self-assigned automatically accepts');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                userClient = client;
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_capability', object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(!vote, 'Should not receive approval request for existing stories till subscribed');
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                // The default group has the same id as the market
                return userClient.markets.followGroup(createdMarketId, [{user_id: userId, is_following: true}]);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    type_object_id: `UNREAD_JOB_APPROVAL_REQUEST_${globalInvestibleId}`});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(vote, 'Should receive approval request for existing stories on subscribe');
                return adminClient.users.pokeInvestible(globalInvestibleId);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    type_object_id: `UNREAD_JOB_APPROVAL_REQUEST_${globalInvestibleId}`});
            }).then(() => {
                const mention = {
                    user_id: adminId,
                    external_id: adminExternalId,
                };
                return userClient.investibles.createComment(globalInvestibleId, createdMarketId, 'body of my comment',
                    null, 'QUESTION', undefined, [mention]);
            }).then((comment) => {
                questionCommentId = comment.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'notification', object_id: adminExternalId,
                        type_object_id: `ISSUE_${questionCommentId}`}, 30000);
            }).then(() => {
                return pollFor(
                    () => userClient.markets.listUsers([{id: adminId, version: 1}]),
                    (users) => {
                        const admin = users.find((user) => user.id === adminId);
                        return Boolean(admin && admin.mentioned_notifications &&
                            admin.mentioned_notifications.length > 0);
                    });
            }).then((users) => {
                const myAdminUser = users.find(obj => {
                    return obj.id === adminId;
                });
                assert(myAdminUser.mentioned_notifications && myAdminUser.mentioned_notifications.length > 0,
                    'admin should show as mentioned');
                // Mention membership lives on the market capability, not the user profile version.
                adminMentionCapabilityVersion = myAdminUser.market_capability_version;
                return getMessages(adminConfiguration);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(openComment, 'Must respond to user opening comment');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(!vote, 'Not fully voted removed if leave comment');
                return adminClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return pollFor(
                    () => userClient.markets.listUsers([{id: adminId, version: 1}]),
                    (users) => {
                        const admin = users.find((user) => user.id === adminId);
                        return Boolean(admin &&
                            admin.market_capability_version > adminMentionCapabilityVersion &&
                            (!admin.mentioned_notifications || admin.mentioned_notifications.length === 0));
                    });
            }).then((users) => {
                const myAdminUser = users.find(obj => {
                    return obj.id === adminId;
                });
                assert(myAdminUser.market_capability_version > adminMentionCapabilityVersion &&
                    (!myAdminUser.mentioned_notifications || myAdminUser.mentioned_notifications.length === 0),
                    'admin should now not show as mentioned');
                return pollFor(
                    () => getMessages(adminConfiguration),
                    (messages) => !messages.find((message) =>
                        message.type_object_id === 'ISSUE_' + questionCommentId));
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(!openComment, 'Resolving comment removes issue notification');
                return pollFor(
                    () => getMessages(userConfiguration),
                    (fetched) => fetched.some((message) =>
                        message.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId));
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(vote, 'Should receive not fully voted when comment resolved');
                return userClient.markets.updateInvestment(globalInvestibleId, 50, 0);
            }).then(() => {
                return pollFor(
                    () => getMessages(adminConfiguration),
                    (messages) => messages.some((message) =>
                        message.type_object_id === `UNREAD_VOTE_${globalInvestibleId}_${userId}`));
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${globalInvestibleId}_${userId}`;
                });
                assert(newVoting, 'Assignee should be notified of investment');
                assert.strictEqual(newVoting.link,
                    `/${createdMarketId}/${globalInvestibleTicketCode}#cv${userId}`,
                    `Planning vote notification should store its canonical short-code link: ${
                        JSON.stringify(newVoting)}`);
                return pollFor(
                    () => getMessages(userConfiguration),
                    (fetched) => !fetched.some((message) =>
                        message.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId));
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(!vote, 'Not fully voted removed on approval');
                return userClient.markets.removeInvestment(globalInvestibleId);
            }).then(() => {
                return pollFor(
                    () => getMessages(adminConfiguration),
                    (messages) => !messages.some((message) =>
                        message.type_object_id === `UNREAD_VOTE_${globalInvestibleId}_${userId}`));
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${globalInvestibleId}_${userId}`;
                });
                assert(!newVoting, 'Unread vote should clear when remove investment');
                return pollFor(
                    () => getMessages(userConfiguration),
                    (fetched) => fetched.some((message) =>
                        message.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId));
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(vote, 'Removing investment restores not fully voted');
                return userClient.investibles.updateComment(questionCommentId, undefined, false);
            }).then(() => {
                return pollFor(
                    () => getMessages(userConfiguration),
                    (messages) => !messages.some((message) =>
                        message.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId));
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + globalInvestibleId;
                });
                assert(!vote, 'Unresolving comment removes not fully voted');
                return pollFor(
                    () => getMessages(adminConfiguration),
                    (fetched) => fetched.some((message) =>
                        message.type_object_id === 'ISSUE_' + questionCommentId));
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(openComment, 'Unresolving comment restores issue notification');
                acceptedStage = globalStages.find(stage => stage.assignee_enter_only);
                inApprovalStage = globalStages.find(stage => stage.allows_investment);
                resolvedStage = globalStages.find(stage => !stage.allows_tasks);
                requiresInputStage = globalStages.find(stage => !stage.allows_issues && stage.move_on_comment);
                const stateOptions = {
                    current_stage_id: inApprovalStage.id,
                    stage_id: acceptedStage.id
                };
                return adminClient.investibles.stateChange(globalInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(openComment, 'Changing to non final stage preserves issue notification');
                const stateOptions = {
                    current_stage_id: acceptedStage.id,
                    stage_id: resolvedStage.id
                };
                return adminClient.investibles.stateChange(globalInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return userClient.investibles.createComment(globalInvestibleId, createdMarketId, 'body of my todo',
                    null, 'TODO');
            }).then((comment) => {
                todoCommentId = comment.id;
                return pollForStage(inApprovalStage.id);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(inApprovalStage.id === stage, 'Investible should move to approval');
                return adminClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return pollFor(
                    () => getMessages(userConfiguration),
                    (messages) => !messages.some((message) =>
                        message.type_object_id === 'ISSUE_' + questionCommentId));
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(!openComment, 'Resolving question removes issue notification');
                return adminClient.investibles.createComment(globalInvestibleId, createdMarketId,
                    'body of my assisted comment', null, 'QUESTION');
            }).then((comment) => {
                questionCommentId = comment.id;
                return pollForStage(requiresInputStage.id);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(requiresInputStage.id === stage, 'Investible should move to assistance');
                return userClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return pollForStage(inApprovalStage.id);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(inApprovalStage.id === stage, 'Investible should move back to former');
                return adminClient.investibles.updateComment(questionCommentId, undefined, false);
            }).then(() => {
                return pollForStage(requiresInputStage.id);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(requiresInputStage.id === stage, 'Investible should move again to assistance');
                return userClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return pollForStage(inApprovalStage.id);
            }).then(() => {
                return adminClient.investibles.createComment(globalInvestibleId, createdMarketId,
                    'body of my assisted comment', null, 'SUGGEST');
            }).then((comment) => {
                questionCommentId = comment.id;
                return pollForStage(requiresInputStage.id);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(requiresInputStage.id === stage, 'Investible moves to assistance for suggest');
                return userClient.investibles.updateComment(questionCommentId, undefined, undefined,
                    undefined, undefined, 'TODO');
            }).then(() => {
                return pollForStage(inApprovalStage.id);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(inApprovalStage.id === stage, 'Investible moves back to former for type change');
                const stateOptions = {
                    current_stage_id: inApprovalStage.id,
                    stage_id: resolvedStage.id
                };
                return adminClient.investibles.stateChange(globalInvestibleId, stateOptions);
            }).then(() => {
                // We get a unread_resolved from auto closing the to-do above
                return userConfiguration.webSocketRunner.waitForReceivedMessages([
                    {event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId,
                        type_object_id: `UNREAD_RESOLVED_${todoCommentId}`}]);
            }).then(() => {
                return adminClient.investibles.createComment(globalInvestibleId, createdMarketId,
                    'review my job', null, 'REPORT');
            }).then((comment) => {
                reportCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment',
                    object_id: createdMarketId}, {event_type: 'notification', object_id: userExternalId,
                    type_object_id: 'UNREAD_REVIEWABLE_' + reportCommentId}]);
            }).then(() => {
                return pollFor(
                    () => getMessages(userConfiguration),
                    (messages) => messages.some((message) =>
                        message.type_object_id === 'UNREAD_REVIEWABLE_' + reportCommentId) &&
                        messages.some((message) =>
                            message.type_object_id === 'UNREAD_RESOLVED_' + todoCommentId));
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_REVIEWABLE_' + reportCommentId;
                });
                assert(review, 'Resolving the investible with a progress report creates review');
                const resolved = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_RESOLVED_' + todoCommentId;
                });
                assert(resolved, 'Moving the investible resolved the todo and so warned the creator');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);

        // This file is registered by both the stage and production promotion suites.
        it('stores a participant follow through cleanup and notifies only Backlog followers', async () => {
            const {client: accountClient, accountToken} = await loginUserToAccountAndGetToken(adminConfiguration);
            const created = await accountClient.markets.createMarket({
                market_type: 'PLANNING', name: 'Backlog participant notifications'
            });
            const marketId = created.market.id;
            const adminClient = await loginUserToMarket(adminConfiguration, marketId);
            const participantClient = await loginUserToMarketInvite(userConfiguration, created.market.invite_capability);
            const participant = await participantClient.users.get();
            await participantClient.markets.followGroup(marketId, [{user_id: participant.id, is_following: true}]);
            const members = await pollFor(
                () => participantClient.markets.listGroupMembers(marketId, [{id: participant.id, version: 1}]),
                (rows) => rows.some((row) => row.id === participant.id && !row.deleted));
            assert(members.some((row) => row.id === participant.id && !row.deleted),
                'The participant must already be a view member before sending the note');

            const backlog = created.stages.find((stage) => !stage.allows_assignment && !stage.close_comments_on_entrance);
            assert(backlog, 'The workspace must have a Backlog stage');
            const job = await adminClient.investibles.create({
                groupId: marketId, name: 'Unassigned discussion', stageId: backlog.id
            });
            const jobId = job.investible.id;
            const marketInfo = job.market_infos.find((info) => info.market_id === marketId);
            assert.strictEqual(marketInfo.stage, backlog.id);
            assert(!marketInfo.assigned?.length, 'The job must remain unassigned');

            async function waitForCommentPush(commentId, version = 1) {
                const pushed = await pollFor(async () => {
                    const summaries = await accountClient.summaries.versions(accountToken, [marketId]);
                    return summaries.signatures?.find((entry) => entry.market_id === marketId)?.signatures
                        ?.filter((entry) => entry.type === 'comment')
                        .flatMap((entry) => entry.object_versions || [])
                        .find((entry) => entry.object_id_one === commentId);
                }, (row) => row?.version >= version);
                assert(pushed?.version >= version, `Comment ${commentId} must finish stream processing`);
            }

            function commentMessages(configuration, commentId) {
                return getMessages(configuration).then((messages) => (messages || []).filter((message) =>
                    message.market_id === marketId && message.comment_id === commentId));
            }

            function participantFollow() {
                return participantClient.markets.listInvestments(participant.id, [
                    {type_object_id: `investible_${marketInfo.id}`, version: 1}
                ]).then((rows) => rows.find((row) => row.type_object_id === `investible_${marketInfo.id}`));
            }

            assert.strictEqual(await participantFollow(), undefined,
                'View membership alone must not create a job follow');

            const note = await participantClient.investibles.createComment(
                jobId, marketId, 'I have participated by sharing context.', null, 'REPORT', undefined, [], 'BLUE');
            await waitForCommentPush(note.id);
            const storedFollow = await pollFor(participantFollow, (row) => row && !row.abstain);
            assert(storedFollow && !storedFollow.abstain, 'The original note author must acquire a stored job follow');
            assert(storedFollow.quantity == null, 'Following from a note must not cast a zero vote');
            assert.strictEqual((await commentMessages(adminConfiguration, note.id)).length, 0,
                'An unmentioned note must remain quiet');

            const skippable = created.stages.find((stage) => !stage.allows_assignment && stage.close_comments_on_entrance);
            assert(skippable, 'The workspace must have a Skippable stage');
            async function moveAndWait(currentStageId, stageId) {
                const moved = await adminClient.investibles.stateChange(jobId,
                    {current_stage_id: currentStageId, stage_id: stageId});
                const movedInfo = moved.market_infos.find((info) => info.market_id === marketId);
                assert.strictEqual(movedInfo.stage, stageId);
                const settled = await pollFor(async () => {
                    const versions = await accountClient.summaries.versions(accountToken, [marketId]);
                    return versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures
                        ?.filter((entry) => entry.type === 'market_investible')
                        .flatMap((entry) => entry.object_versions || [])
                        .find((entry) => entry.object_id_one === marketInfo.id && entry.object_id_two === jobId);
                }, (row) => row?.version >= movedInfo.version);
                assert(settled?.version >= movedInfo.version,
                    `Stage ${stageId} stream processing must finish before continuing`);
            }
            await moveAndWait(backlog.id, skippable.id);
            await moveAndWait(skippable.id, backlog.id);
            const cleanedFollow = await pollFor(participantFollow, (row) => row?.deleted);
            assert(cleanedFollow?.deleted, 'The existing stage cleanup must still delete voting state');
            assert.strictEqual(cleanedFollow.abstain, false, 'Voting cleanup must preserve the stored follow');
            assert(cleanedFollow.quantity == null, 'Voting cleanup must not invent quantity');

            const workspacePresences = await pollFor(async () => {
                const summaries = await accountClient.summaries.versions(accountToken, [marketId]);
                return summaries.signatures?.find((entry) => entry.market_id === marketId)?.signatures
                    ?.find((entry) => entry.type === 'market_capability')?.object_versions || [];
            }, (rows) => rows.length >= 3);
            assert(workspacePresences.length >= 3,
                'Both humans and the planning AI must be provisioned before the one-shot suggestion write');
            const token = await mcpLogin(adminConfiguration, adminClient, marketId);
            const ready = await pollFor(
                () => mcpCall(adminConfiguration, token, 'get_job', {short_code_id: marketInfo.ticket_code}),
                (raw) => JSON.parse(raw).result?.isError !== true);
            assert.notStrictEqual(JSON.parse(ready).result?.isError, true,
                'MCP reads must be ready before the one-shot suggestion write');
            const raw = await mcpCall(adminConfiguration, token, 'make_suggestion', {
                job_id: marketInfo.ticket_code, suggestion: 'An AI idea for the unassigned Backlog job.'
            });
            const result = JSON.parse(raw).result;
            assert.notStrictEqual(result?.isError, true, raw);
            const suggestion = result.structuredContent;
            assert(suggestion?.comment_id && suggestion.short_code_id, raw);
            await waitForCommentPush(suggestion.comment_id);
            const messages = await pollFor(
                () => commentMessages(userConfiguration, suggestion.comment_id), (rows) => rows.length > 0);
            assert.strictEqual(messages.length, 1, JSON.stringify(messages));
            assert.strictEqual(messages[0].type_object_id, `UNREAD_COMMENT_${suggestion.comment_id}`);
            assert.strictEqual(messages[0].link, `/${marketId}/${suggestion.short_code_id}`);
            assert.strictEqual(messages[0].alert_type, 'AI_GENERATED');
            assert.strictEqual((await commentMessages(adminConfiguration, suggestion.comment_id)).length, 0,
                'The job creator and uninvolved view member must receive no suggestion row');

            const [persisted] = await adminClient.investibles.getMarketComments([
                {id: suggestion.comment_id, version: 1}
            ]);
            assert.strictEqual(persisted.comment_type, 'SUGGEST');
            assert(!persisted.inline_market_id, 'The AI suggestion must exercise ordinary job comment delivery');
            await participantClient.users.removeNotification(`UNREAD_COMMENT_${suggestion.comment_id}`);
            const cleared = await pollFor(
                () => commentMessages(userConfiguration, suggestion.comment_id), (rows) => rows.length === 0);
            assert.strictEqual(cleared.length, 0, 'Remove only the observed suggestion row before verifying its update');
            const updated = await adminClient.investibles.updateComment(suggestion.comment_id,
                'A human updates the AI idea.', undefined, undefined, [], undefined, undefined,
                undefined, undefined, undefined, undefined, undefined, undefined, persisted.version);
            await waitForCommentPush(suggestion.comment_id, updated.version);
            const updatedMessages = await pollFor(
                () => commentMessages(userConfiguration, suggestion.comment_id), (rows) => rows.length > 0);
            assert.strictEqual(updatedMessages.length, 1, 'An update must recreate one comment-specific participant row');
            assert.strictEqual(updatedMessages[0].type_object_id, `UNREAD_COMMENT_${suggestion.comment_id}`);
            assert.strictEqual(updatedMessages[0].link, `/${marketId}/${suggestion.short_code_id}`);
            assert.strictEqual((await commentMessages(adminConfiguration, suggestion.comment_id)).length, 0);

            const admin = await adminClient.users.get();
            const mentionedNote = await participantClient.investibles.createComment(jobId, marketId,
                'A note explicitly addressed to the otherwise uninvolved creator.', null, 'REPORT', undefined,
                [{user_id: admin.id, external_id: admin.external_id}], 'BLUE');
            await waitForCommentPush(mentionedNote.id);
            const mentionedMessages = await pollFor(
                () => commentMessages(adminConfiguration, mentionedNote.id), (rows) => rows.length > 0);
            assert.strictEqual(mentionedMessages.length, 1, 'A Backlog note must retain explicit mention delivery');
            assert.strictEqual((await commentMessages(userConfiguration, mentionedNote.id)).length, 0);

            const silentRaw = await mcpCall(adminConfiguration, token, 'add_info', {
                short_code_id: note.ticket_code, info: 'A silent reply to the human participant.',
                tz: 'America/Los_Angeles', is_silent: true
            });
            const silent = JSON.parse(silentRaw).result;
            assert.notStrictEqual(silent?.isError, true, silentRaw);
            await waitForCommentPush(silent.structuredContent.comment_id, silent.structuredContent.version);
            const [silentReply] = await adminClient.investibles.getMarketComments([
                {id: silent.structuredContent.comment_id, version: silent.structuredContent.version}
            ]);
            assert.strictEqual(silentReply.investible_id, jobId);
            assert.strictEqual(silentReply.comment_type, 'REPLY');
            assert.strictEqual(silentReply.is_silent, true);
            assert.strictEqual(silentReply.reply_id, note.id);
            assert.strictEqual((await commentMessages(adminConfiguration, silent.structuredContent.comment_id)).length, 0);
            assert.strictEqual((await commentMessages(userConfiguration, silent.structuredContent.comment_id)).length, 0,
                'The human parent author must receive no row for the silent reply');
        }).timeout(600000);
    });
};
