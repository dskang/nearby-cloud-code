require("cloud/app.js");
require("cloud/facebook.js");

var utils = require("cloud/utils.js");

// Max distance between nearby users
// 150 meters =~ 0.1 miles =~ 2 minute walk
var NEARBY_DISTANCE = 150;

// Max distance to wave to a user
var WAVE_DISTANCE = NEARBY_DISTANCE * 2;

// Number of seconds before a location is considered stale
var LOCATION_STALE_AGE = 60 * 5;

// Number of seconds before a nearby notification is sent about the same friend
var NOTIFICATION_INTERVAL = 60 * 30;

var getDistance = function(user1, user2) {
  var user1Location = user1.get("location");
  var user2Location = user2.get("location");
  var distance = utils.haversineDistance(
    user1Location.latitude, user1Location.longitude,
    user2Location.latitude, user2Location.longitude);
  return distance;
};

// Return true if user1 and user2 are best friends
var isBestFriend = function(user1, user2) {
  var bestFriends = user1.get("bestFriends");
  if (bestFriends) {
    for (var i = 0; i < bestFriends.length; i++) {
      var bestFriend = bestFriends[i];
      if (bestFriend.id === user2.id) {
        return true;
      }
    }
  }
  return false;
};

// Return true if user1 blocked user2
var hasBlocked = function(user1, user2) {
  var blockedUsers = user1.get("blockedUsers");
  if (blockedUsers) {
    for (var i = 0; i < blockedUsers.length; i++) {
      var blockedUser = blockedUsers[i];
      if (blockedUser.id === user2.id) {
        return true;
      }
    }
  }
  return false;
};

var errorHandler = function(response) {
  return function(error) {
    var message;
    if (error.code && error.message) {
      message = "(" + error.code + "): " + error.message;
    } else {
      message = error;
    }
    response.error(message);
  };
}

// Return a promise for the nearby notifications for the user
var getNearbyNotifications = function(user) {
  var NearbyNotification = Parse.Object.extend("NearbyNotification");
  var fromNotificationQuery = new Parse.Query(NearbyNotification);
  fromNotificationQuery.equalTo("fromUser", user);
  var toNotificationQuery = new Parse.Query(NearbyNotification);
  toNotificationQuery.equalTo("toUser", user);
  var query = Parse.Query.or(fromNotificationQuery, toNotificationQuery);
  return query.find();
};

// Return nearby friends who were not previously nearby
var getNewNearbyFriends = function(nearbyFriends, nearbyNotifications) {
  var newNearbyFriends = nearbyFriends.filter(function(friend) {
    var alreadyNearby = false;
    for (var i = 0; i < nearbyNotifications.length; i++) {
      var notification = nearbyNotifications[i];
      var fromFriend = notification.get("fromUser").id === friend.id;
      var toFriend = notification.get("toUser").id === friend.id;
      if (fromFriend || toFriend) {
        alreadyNearby = notification.get("currentlyNearby");
        break;
      }
    }
    return !alreadyNearby;
  });
  return newNearbyFriends;
};

// Return a new or updated notification for each newly nearby friend
var getNewNotifications = function(newNearbyFriends, nearbyNotifications, user) {
  var newNotifications = newNearbyFriends.map(function(friend) {
    var nearbyNotification;
    for (var i = 0; i < nearbyNotifications.length; i++) {
      var notification = nearbyNotifications[i];
      var fromFriend = notification.get("fromUser").id === friend.id;
      var toFriend = notification.get("toUser").id === friend.id;
      if (fromFriend || toFriend) {
        nearbyNotification = notification;
        break;
      }
    }

    if (!nearbyNotification) {
      var NearbyNotification = Parse.Object.extend("NearbyNotification");
      nearbyNotification = new NearbyNotification();
      nearbyNotification.set("fromUser", user);
      nearbyNotification.set("toUser", friend);
    }

    nearbyNotification.set("currentlyNearby", true);
    return nearbyNotification;
  });
  return newNotifications;
};

// Return nearby friends who should be notified about user's nearness
var getFriendsToNotify = function(newNearbyFriends, notifications) {
  var friendsToNotify = [];
  for (var i = 0; i < newNearbyFriends.length; i++) {
    var friend = newNearbyFriends[i];
    var nearbyNotification;
    for (var j = 0; j < notifications.length; j++) {
      var notification = notifications[i];
      var fromFriend = notification.get("fromUser").id === friend.id;
      var toFriend = notification.get("toUser").id === friend.id;
      if (fromFriend || toFriend) {
        nearbyNotification = notification;
        break;
      }
    }

    var lastNotified = nearbyNotification.get("lastNotified");
    var interval;
    if (lastNotified) {
      var currentTimestamp = Date.now() / 1000; // convert from ms to seconds
      var notifiedTimestamp = lastNotified.getTime() / 1000;
      interval = currentTimestamp - notifiedTimestamp;
    }
    if (!lastNotified || interval >= NOTIFICATION_INTERVAL) {
      nearbyNotification.set("lastNotified", new Date());
      friendsToNotify.push(friend);
    }
  }
  return friendsToNotify;
}

// Return notifications for friends who are no longer nearby
var getOldNotifications = function(nearbyFriends, nearbyNotifications) {
  var oldNotifications = nearbyNotifications.filter(function(notification) {
    if (!notification.get("currentlyNearby")) {
      return false;
    }

    var currentlyNearby = false;
    for (var i = 0; i < nearbyFriends.length; i++) {
      var friend = nearbyFriends[i];
      var fromFriend = notification.get("fromUser").id === friend.id;
      var toFriend = notification.get("toUser").id === friend.id;
      if (fromFriend || toFriend) {
        currentlyNearby = true;
        break;
      }
    }

    if (!currentlyNearby) {
      notification.set("currentlyNearby", false);
      return true;
    } else {
      return false;
    }
  });
  return oldNotifications;
}

Parse.Cloud.define("updateLocation", function(request, response) {
  Parse.Cloud.useMasterKey();
  var user = request.user;
  if (!user) {
    response.error("Request does not have an associated user.");
    return;
  }

  var location = request.params;
  user.set("location", location);
  user.save().then(function(user) {
    var promises = [getNearbyFriends(user), getNearbyNotifications(user)];
    return Parse.Promise.when(promises);
  }).then(function(nearbyFriends, nearbyNotifications) {
    // Don't consider nearby friends whose locations are stale
    nearbyFriends = nearbyFriends.filter(function(friend) {
      var location = friend.get("location");
      var currentTimestamp = Date.now() / 1000; // convert from ms to seconds
      var locationAge = currentTimestamp - location["timestamp"];
      return (locationAge < LOCATION_STALE_AGE);
    });

    // Don't consider nearby friends whose locations may be inaccurate
    // TODO: Remove once filtered from client side
    nearbyFriends = nearbyFriends.filter(function(friend) {
      var location = friend.get("location");
      return location["accuracy"] < NEARBY_DISTANCE * 2;
    });

    // Get nearby friends who were not previously nearby
    var newNearbyFriends = getNewNearbyFriends(nearbyFriends, nearbyNotifications);

    var promises = [];

    // Create or update notifications for friends who are newly nearby
    var newNotifications = getNewNotifications(newNearbyFriends, nearbyNotifications, user);
    var friendsToNotify = getFriendsToNotify(newNearbyFriends, newNotifications);
    if (newNotifications.length > 0) {
      promises.push(Parse.Object.saveAll(newNotifications));
    }

    // Update notifications for friends who are no longer nearby
    var oldNotifications = getOldNotifications(nearbyFriends, nearbyNotifications);
    if (oldNotifications.length > 0) {
      promises.push(Parse.Object.saveAll(oldNotifications));
    }

    return Parse.Promise.when(promises).then(function() {
      return Parse.Promise.as(friendsToNotify);
    });
  }).then(function(friends) {
    var promises = [];

    // Notify nearby friends about user
    // for (var i = 0; i < friends.length; i++) {
    //   var friend = friends[i];
    //   var pushQuery = new Parse.Query(Parse.Installation);
    //   pushQuery.equalTo("user", friend);
    //   var pushMessage = user.get("name") + " is nearby!";
    //   var pushToFriend = Parse.Push.send({
    //     where: pushQuery,
    //     expiration_interval: 60 * 30, // 30 minutes
    //     data: {
    //       type: "nearbyFriend",
    //       alert: pushMessage,
    //       senderId: user.id,
    //       senderName: user.get("name")
    //     }
    //   });
    //   promises.push(pushToFriend);
    // }

    // Notify user about nearby friends
    if (friends.length > 0) {
      var firstFriend = friends[0];
      var pushMessage = firstFriend.get("name");
      var othersCount = friends.length - 1;
      if (othersCount > 1) {
        pushMessage += " and " + othersCount + " other friends are nearby!";
      } else if (othersCount === 1) {
        pushMessage += " and 1 other friend are nearby!";
      } else {
        pushMessage += " is nearby!";
      }
      var pushQuery = new Parse.Query(Parse.Installation);
      pushQuery.equalTo("user", user);
      var pushToUser = Parse.Push.send({
        where: pushQuery,
        expiration_interval: 60 * 30, // 30 minutes
        data: {
          type: "nearbyFriend",
          alert: pushMessage,
          senderId: firstFriend.id,
          senderName: firstFriend.get("name")
        }
      });
      promises.push(pushToUser);
    }

    return Parse.Promise.when(promises);
  }).then(function() {
    response.success();
  }, errorHandler(response));
});

var getNearbyFriends = function(user) {
  var relation = user.relation("friends");
  var friendQuery = relation.query();
  friendQuery.select("location", "name");
  // Don't include people who are hidden
  friendQuery.notEqualTo("hideLocation", true);
  // Don't include people who have blocked user
  friendQuery.notEqualTo("blockedUsers", user);
  // Don't include people who user has blocked
  var blockedUsers = user.get("blockedUsers");
  if (blockedUsers) {
    var blockedIds = blockedUsers.map(function(blockedUser) {
      return blockedUser.id;
    });
    friendQuery.notContainedIn("objectId", blockedIds);
  }
  return friendQuery.find().then(function(friends) {
    var nearbyFriends = friends.filter(function(friend) {
      return getDistance(user, friend) <= NEARBY_DISTANCE;
    });
    return Parse.Promise.as(nearbyFriends);
  });
};

var getBestFriends = function(user) {
  var bestFriends = user.get("bestFriends");
  if (!bestFriends) {
    return Parse.Promise.as([]);
  }
  var bestFriendsIds = bestFriends.map(function(friend) {
    return friend.id
  });
  var bestFriendsQuery = new Parse.Query(Parse.User);
  bestFriendsQuery.select("hideLocation", "location", "name", "firstName", "blockedUsers");
  bestFriendsQuery.containedIn("objectId", bestFriendsIds);
  // Don't include people who user has blocked
  var blockedUsers = user.get("blockedUsers");
  if (blockedUsers) {
    var blockedIds = blockedUsers.map(function(blockedUser) {
      return blockedUser.id;
    });
    bestFriendsQuery.notContainedIn("objectId", blockedIds);
  }
  return bestFriendsQuery.find();
};

// Send a silent notification to get new location is current data is stale
var requestUpdatedLocation = function(user) {
  var hidden = user.get("hideLocation");
  if (!hidden) {
    var location = user.get("location");
    var locationAge;
    if (location) {
      var currentTimestamp = Date.now() / 1000; // convert from ms to seconds
      locationAge = currentTimestamp - location["timestamp"];
    }
    if (!location || locationAge > LOCATION_STALE_AGE) {
      var pushQuery = new Parse.Query(Parse.Installation);
      pushQuery.equalTo("user", user);
      return Parse.Push.send({
        where: pushQuery,
        data: {
          "content-available": 1,
          type: "updateLocation"
        }
      });
    }
  }
  return Parse.Promise.as();
};

Parse.Cloud.define("nearbyFriends", function(request, response) {
  var user = request.user;
  if (!user) {
    response.error("Request does not have an associated user.");
    return;
  }

  if (!user.get("location")) {
    response.error("User's location is not set.");
    return;
  }

  var promises = [getNearbyFriends(user), getBestFriends(user)];
  Parse.Promise.when(promises).then(function(nearbyFriends, bestFriends) {
    // Filter out best friends in the nearbyFriends list
    bestFriends = bestFriends.filter(function(bestFriend) {
      for (var i = 0; i < nearbyFriends.length; i++) {
        var nearbyFriend = nearbyFriends[i];
        if (nearbyFriend.id === bestFriend.id) {
          return false;
        }
      }
      return true;
    });

    // Remove locations from friends who are hidden or have blocked user
    var bestFriendsJSON = bestFriends.map(function(friend) {
      var friendJSON = friend.toJSON();
      friendJSON["__type"] = "Object";
      friendJSON["className"] = "_User";
      var hidden = friend.get("hideLocation");
      var blocked = hasBlocked(friend, user);
      if (hidden || blocked) {
        friendJSON["hideLocation"] = true;
        delete friendJSON["location"];
      }
      delete friendJSON["blockedUsers"];
      return friendJSON;
    });

    var respond = function() {
      response.success({
        nearbyFriends: nearbyFriends,
        bestFriends: bestFriendsJSON
      });
    }

    // Request updated locations for friends with stale locations
    var pushPromises = [];
    var friends = nearbyFriends.concat(bestFriends);
    for (var i = 0; i < friends.length; i++) {
      var friend = friends[i];
      // pushPromises.push(requestUpdatedLocation(friend));
    }
    // Respond with friends regardless of push notification success
    Parse.Promise.when(pushPromises).then(respond, respond);
  }, errorHandler(response));
});

Parse.Cloud.define("wave", function(request, response) {
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var message = request.params.message;
  if (!message) {
    message = "👋🏽";
  }
  var recipientId = request.params.recipientId;

  // Validate that sender is friends with recipient
  var relation = sender.relation("friends");
  var friendQuery = relation.query();
  friendQuery.equalTo("objectId", recipientId);
  friendQuery.find().then(function(results) {
    if (results.length === 0) {
      return Parse.Promise.error("No friend found.");
    }
    var recipient = results[0];
    // Validate that recipient is not hidden
    var hidden = recipient.get("hideLocation") === true;
    // Validate that sender is within waving distance of recipient if they're not best friends
    var tooFar = !isBestFriend(sender, recipient) && getDistance(sender, recipient) > WAVE_DISTANCE;
    // Validate that recipient has not blocked sender
    var blocked = hasBlocked(recipient, sender);
    if (hidden || tooFar || blocked) {
      return Parse.Promise.error(recipient.get("firstName") + " is no longer nearby.")
    }

    var pushQuery = new Parse.Query(Parse.Installation);
    pushQuery.equalTo("user", recipient);

    var pushMessage = sender.get("name") + ": " + message;
    return Parse.Push.send({
      where: pushQuery,
      expiration_interval: 60 * 60 * 24, // 1 day
      data: {
        type: "wave",
        alert: pushMessage,
        sound: "default",
        senderId: sender.id,
        senderName: sender.get("name")
      }
    });
  }).then(function() {
    response.success();
  }, errorHandler(response));
});

// Return a promise for the best friend requests between sender and recipient
var getBestFriendRequests = function(sender, recipient) {
  var BestFriendRequest = Parse.Object.extend("BestFriendRequest");
  var requestFromSenderQuery = new Parse.Query(BestFriendRequest);
  requestFromSenderQuery.equalTo("fromUser", sender);
  requestFromSenderQuery.equalTo("toUser", recipient);
  var requestToSenderQuery = new Parse.Query(BestFriendRequest);
  requestToSenderQuery.equalTo("fromUser", recipient);
  requestToSenderQuery.equalTo("toUser", sender);
  var query = Parse.Query.or(requestFromSenderQuery, requestToSenderQuery);
  return query.find();
};

Parse.Cloud.define("addBestFriend", function(request, response) {
  Parse.Cloud.useMasterKey();
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var recipientId = request.params.recipientId;
  // Validate that sender is friends with recipient
  var relation = sender.relation("friends");
  var friendQuery = relation.query();
  friendQuery.equalTo("objectId", recipientId);
  friendQuery.find().then(function(results) {
    if (results.length === 0) {
      return Parse.Promise.error("No friend found.");
    }
    var recipient = results[0];
    // Validate that sender is not already best friends with recipient
    if (isBestFriend(sender, recipient)) {
      return Parse.Promise.error("You are already best friends.");
    }

    return getBestFriendRequests(sender, recipient).then(function(results) {
      if (results.length > 0) {
        var bestFriendRequest = results[0];
        var userSentRequest = bestFriendRequest.get("fromUser").id === sender.id;
        if (userSentRequest) {
          return Parse.Promise.error("You have already sent a best friend request.");
        }

        // Accept best friend request
        recipient.addUnique("bestFriends", sender);
        sender.addUnique("bestFriends", recipient);
        var promises = [bestFriendRequest.destroy(), recipient.save(), sender.save()];
        return Parse.Promise.when(promises);
      } else {
        var BestFriendRequest = Parse.Object.extend("BestFriendRequest");
        var bestFriendRequest = new BestFriendRequest()
        bestFriendRequest.set("fromUser", sender);
        bestFriendRequest.set("toUser", recipient);

        var pushQuery = new Parse.Query(Parse.Installation);
        pushQuery.equalTo("user", recipient);

        var pushPromise = Parse.Push.send({
          where: pushQuery,
          data: {
            type: "bestFriendRequest",
            alert: sender.get("name") + " added you as a best friend.",
            sound: "default"
          }
        });
        var promises = [bestFriendRequest.save(), pushPromise];
        return Parse.Promise.when(promises);
      }
    });
  }).then(function() {
    response.success();
  }, errorHandler(response));
});

Parse.Cloud.define("removeBestFriendRequest", function(request, response) {
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var recipientId = request.params.recipientId;
  var recipient = new Parse.User();
  recipient.id = recipientId;

  getBestFriendRequests(sender, recipient).then(function(results) {
    if (results.length > 0) {
      var bestFriendRequest = results[0];
      return bestFriendRequest.destroy();
    } else {
      return Parse.Promise.error("No best friend request found.");
    }
  }).then(function() {
    response.success();
  }, errorHandler(response));
});

Parse.Cloud.define("removeBestFriend", function(request, response) {
  Parse.Cloud.useMasterKey();
  var sender = request.user;
  if (!sender) {
    response.error("Request does not have an associated user.");
    return;
  }

  var recipientId = request.params.recipientId;
  var recipient = new Parse.User();
  recipient.id = recipientId;

  var bf = isBestFriend(sender, recipient);
  if (!bf) {
    response.error("No best friend to remove.");
    return;
  }

  recipient.remove("bestFriends", sender);
  sender.remove("bestFriends", recipient);

  var promises = [recipient.save(), sender.save()];
  Parse.Promise.when(promises).then(function() {
    response.success();
  }, errorHandler(response));
});
