// Number of seconds before an alert can be sent about the same friend
var NOTIFICATION_INTERVAL = 60 * 30;

// Number of seconds a friend must be nearby before an alert is sent
var NEARBY_INTERVAL = 60;

var Alert = Parse.Object.extend("Alert", {
  // Instance methods
  recentlySent: function() {
    var lastSent = this.get("lastSent");
    if (lastSent) {
      var currentTimestamp = Date.now() / 1000; // convert from ms to seconds
      var sentTimestamp = lastSent.getTime() / 1000;
      var interval = currentTimestamp - sentTimestamp;
      return (interval < NOTIFICATION_INTERVAL);
    } else {
      return false;
    }
  },
  shouldSend: function() {
    var currentlyNearby = this.get("currentlyNearby");
    var pending = this.get("pending");
    var nearbyStart = this.get("nearbyStart");
    var currentTimestamp = Date.now() / 1000; // convert from ms to seconds
    var nearbyTimestamp = nearbyStart.getTime() / 1000;
    var interval = currentTimestamp - nearbyTimestamp;
    return currentlyNearby && pending && !this.recentlySent() && (interval >= NEARBY_INTERVAL);
  },
  includesUser: function(user) {
    var fromMatch = this.get("fromUser").id === user.id;
    var toMatch = this.get("toUser").id === user.id;
    return (fromMatch || toMatch);
  }
}, {
  // Class methods
  // Get all alerts for the user
  queryForUser: function(user) {
    var fromQuery = new Parse.Query(Alert);
    fromQuery.equalTo("fromUser", user);
    var toQuery = new Parse.Query(Alert);
    toQuery.equalTo("toUser", user);
    var query = Parse.Query.or(fromQuery, toQuery);
    return query.find();
  },
  alertForUser: function(user, alerts) {
    for (var i = 0; i < alerts.length; i++) {
      var alert = alerts[i];
      if (alert.includesUser(user)) {
        return alert;
      }
    }
    return null;
  },
  // Update alerts for nearby friends and friends who are no longer nearby
  updateWithNearbyFriends: function(nearbyFriends, alerts, user) {
    var updatedAlerts = [];
    // Update or create alerts for nearby friends who were not already nearby
    for (var i = 0; i < nearbyFriends.length; i++) {
      var friend = nearbyFriends[i];
      var alertForFriend = Alert.alertForUser(friend, alerts);

      if (!alertForFriend) {
        alertForFriend = new Alert();
        alertForFriend.set("fromUser", user);
        alertForFriend.set("toUser", friend);
      }

      var alreadyNearby = alertForFriend.get("currentlyNearby");
      if (!alreadyNearby) {
        alertForFriend.set("currentlyNearby", true);
        if (!alertForFriend.recentlySent()) {
          alertForFriend.set("nearbyStart", new Date());
          alertForFriend.set("pending", true);
        }
        updatedAlerts.push(alertForFriend);
      }
    }

    // Update alerts for friends who are no longer nearby
    for (var i = 0; i < alerts.length; i++) {
      var alert = alerts[i];
      var wasNearby = alert.get("currentlyNearby");
      if (wasNearby) {
        var currentlyNearby = false;
        for (var j = 0; j < nearbyFriends.length; j++) {
          var friend = nearbyFriends[j];
          if (alert.includesUser(friend)) {
            currentlyNearby = true;
            break;
          }
        }

        if (!currentlyNearby) {
          alert.set("currentlyNearby", false);
          alert.set("pending", false);
          updatedAlerts.push(alert);
        }
      }
    }

    return Parse.Object.saveAll(updatedAlerts);
  },
  sendAlerts: function(user, friendsToAlert, alerts) {
    var promises = [];

    // Update alerts
    var updatedAlerts = friendsToAlert.map(function(friend) {
      var alert = Alert.alertForUser(friend, alerts);
      alert.set("pending", false);
      alert.set("lastSent", new Date());
      return alert;
    });
    if (updatedAlerts.length > 0) {
      promises.push(Parse.Object.saveAll(updatedAlerts));
    }

    // Notify nearby friends about user
    for (var i = 0; i < friendsToAlert.length; i++) {
      var friend = friendsToAlert[i];
      var pushQuery = new Parse.Query(Parse.Installation);
      pushQuery.equalTo("user", friend);
      var pushMessage = user.get("name") + " is nearby!";
      var pushToFriend = Parse.Push.send({
        where: pushQuery,
        expiration_interval: 60 * 30, // 30 minutes
        data: {
          type: "nearbyFriend",
          alert: pushMessage,
          senderId: user.id,
          senderName: user.get("name")
        }
      });
      promises.push(pushToFriend);
    }

    // Notify user about nearby friends
    if (friendsToAlert.length > 0) {
      var firstFriend = friendsToAlert[0];
      var pushMessage = firstFriend.get("name");
      var othersCount = friendsToAlert.length - 1;
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
    return promises;
  }
});

module.exports = Alert;
