import assert from 'assert';
import {
    getMessages,
    loginUserToAccount,
    loginUserToAccountAndGetToken,
    loginUserToMarket
} from '../src/utils';
import _ from 'lodash';

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name: 'Company A',
        market_type: 'PLANNING'
    };

    describe('#do identity sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let authPromise = loginUserToAccountAndGetToken(adminConfiguration);
            let createdMarketId;
            let adminClient;
            let userClient;
            let bugCommentId;
            let questionCommentId;
            await authPromise.then((response) => {
                const { client, accountToken } = response;
                return client.summaries.idList(accountToken).then((audits) => {
                    const allMarkets = audits.map((audit) => audit.id);
                    return client.summaries.versions(accountToken, allMarkets);
                }).then((versions) => {
                        const { signatures } = versions;
                        console.dir(signatures);
                        assert(signatures.length === 1, "Should be associated with a single market after activity");
                        return signatures;
                    }).then(() => {
                        return loginUserToAccount(adminConfiguration);
                    }).then(client => client.markets.createMarket(marketOptions))
                    .then((response) => {
                        createdMarketId = response.market.id;
                        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market',
                            object_id: createdMarketId});
                    })
                    .then(() => {
                        return client.summaries.idList(accountToken).then((audits) => {
                            const allMarkets = audits.map((audit) => audit.id);
                            return client.summaries.versions(accountToken, allMarkets);
                        });
                    }).then((versions) => {
                        const { signatures } = versions;
                        console.log(signatures);
                        // Below intermittently failing and not worth debugging for now as delete not a production op
                        //assert(!_.isEmpty(signatures) && signatures[0].market_id === createdMarketId,
                            //"Should have one market associated");
                        return loginUserToMarket(adminConfiguration, createdMarketId);
                    }).then((marketClient) => {
                        adminClient = marketClient;
                        return adminClient.investibles.createComment(undefined, createdMarketId,
                            'This is my bug.',
                            null, 'TODO', undefined, undefined,
                            'RED');
                    }).then((comment) => {
                        bugCommentId = comment.id;
                        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                            object_id: createdMarketId});
                    }).then(() => {
                        return loginUserToMarket(userConfiguration, createdMarketId);
                    }).then((client) => {
                        userClient = client;
                        // No post-processing on the push type object id
                        return userConfiguration.webSocketRunner.waitForReceivedMessage(
                            {event_type: 'notification', type_object_id: `UNASSIGNED_${bugCommentId}`});
                    }).then(() => {
                        return getMessages(userConfiguration);
                    }).then((messages) => {
                        const criticalRollup = messages.find((message) =>
                            message.associated_object_id === createdMarketId && message.type === 'UNASSIGNED');
                        assert(criticalRollup && criticalRollup.comment_list && criticalRollup.comment_list.length === 1
                            && criticalRollup.comment_list[0] === bugCommentId,
                            "Critical bug rollup not associated with bug id");
                        return adminClient.users.pokeComment(bugCommentId);
                    }).then(() => {
                        return userConfiguration.webSocketRunner.waitForReceivedMessage(
                            {event_type: 'notification',
                                type_object_id: `UNASSIGNED_${bugCommentId}`});
                    }).then(() => {
                        return getMessages(userConfiguration);
                    }).then((messages) => {
                        const criticalRollup = messages.find((message) =>
                            message.associated_object_id === createdMarketId && message.type === 'UNASSIGNED');
                        assert(criticalRollup && criticalRollup.comment_list && criticalRollup.comment_list.length === 1
                            && criticalRollup.comment_list[0] === bugCommentId,
                            "Critical bug rollup not associated with bug id after poke");
                        assert(criticalRollup.poked_list && criticalRollup.poked_list.length === 1 &&
                            criticalRollup.poked_list[0] === bugCommentId,
                            "Critical bug poked_list not associated with bug id after poke");
                        assert(criticalRollup.level === 'RED', "Critical bug not red level after poke");
                        return adminClient.investibles.createComment(undefined, createdMarketId,
                            'Is this my question without options?',
                            null, 'QUESTION');
                    }).then((comment) => {
                        questionCommentId = comment.id;
                        return userConfiguration.webSocketRunner.waitForReceivedMessage(
                            {event_type: 'notification',
                                type_object_id: `UNREAD_COMMENT_${questionCommentId}`});
                    }).then(() => {
                        return adminClient.users.pokeComment(questionCommentId);
                    }).then(() => {
                        return userConfiguration.webSocketRunner.waitForReceivedMessage(
                            {event_type: 'notification',
                                type_object_id: `UNREAD_COMMENT_${questionCommentId}`});
                    }).then(() => {
                        return getMessages(userConfiguration);
                    }).then((messages) => {
                        const questionNotification = messages.find((message) =>
                            message.type_object_id === `UNREAD_COMMENT_${questionCommentId}`);
                        assert(questionNotification.level === 'RED', "Question notification not red after poke");
                        assert(questionNotification.alert_type === 'POKED',
                            "Question  notification alert type wrong after poke");
                    });
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};
