var utils = require("cloud/utils.js");

// Max distance between nearby users
// 150 meters =~ 0.1 miles =~ 2 minute walk
var NEARBY_DISTANCE = 150;

// Max distance to wave to a user
var WAVE_DISTANCE = NEARBY_DISTANCE * 2;

var getDistance = function(user1, user2) {
  var user1Location = user1.get("location");
  var user2Location = user2.get("location");
  var distance = utils.haversineDistance(
    user1Location.latitude, user1Location.longitude,
    user2Location.latitude, user2Location.longitude);
  return distance;
};

Parse.Cloud.define("updateFriends", function(request, response) {
  var user = request.user;
  if (!user) {
    response.error("Request does not have an associated user.");
    return;
  }

  var authData = user.get("authData");
  var accessToken = authData["facebook"]["access_token"];

  // Get Facebook friends
  Parse.Cloud.httpRequest({
    url: "https://graph.facebook.com/me/friends",
    params: {
      access_token: accessToken,
      limit: 5000 // get all friends in one request
    },
    success: function(httpResponse) {
      var friends = httpResponse.data.data;
      var friendFbIds = friends.map(function(friend) { return friend.id });
      var friendQuery = new Parse.Query(Parse.User);
      friendQuery.containedIn("fbId", friendFbIds);
      friendQuery.find({
        success: function(results) {
          var relation = user.relation("friends");
          for (var i = 0; i < results.length; i++) {
            var friend = results[i];
            relation.add(friend);
          }
          user.save(null, {
            success: function(user) {
              response.success();
            },
            error: function(user, error) {
              response.error("Error: " + error.code + " " + error.message);
            }
          });
        },
        error: function(error) {
          response.error("Error: " + error.code + " " + error.message);
        }
      });
    },
    error: function(httpResponse) {
      var error = httpResponse.data.error;
      response.error(error.type + " (" + error.code + "): " + error.message);
    }
  });
});

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

  var relation = user.relation("friends");
  var friendQuery = relation.query();
  friendQuery.select("location", "name");
  friendQuery.notEqualTo("hideLocation", true);
  friendQuery.find({
    success: function(results) {
      var nearbyFriends = results.filter(function(friend) {
        return getDistance(user, friend) <= NEARBY_DISTANCE;
      });
      response.success(nearbyFriends);
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});

Parse.Cloud.define("wave", function(request, response) {
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
  friendQuery.find({
    success: function(results) {
      if (results.length === 0) {
        response.error("No friend found.");
        return;
      }

      var recipient = results[0];
      // Validate that recipient is not hidden
      var hidden = recipient.get("hideLocation") === true;
      // Validate that sender is within waving distance of recipient
      var tooFar = getDistance(sender, recipient) > WAVE_DISTANCE;
      if (hidden || tooFar) {
        response.error(recipient.get("name") + " is no longer nearby.")
        return;
      }

      var pushQuery = new Parse.Query(Parse.Installation);
      pushQuery.equalTo("user", recipient);

      Parse.Push.send({
        where: pushQuery,
        expiration_interval: 60 * 60 * 24, // 1 day
        data: {
          type: "wave",
          alert: sender.get("name") + " waved at you!",
          senderId: sender.id,
          senderName: sender.get("name")
        }
      }, {
        success: function() {
          response.success();
        },
        error: function(error) {
          response.error("Error: " + error.code + " " + error.message);
        }
      });
    },
    error: function(error) {
      response.error("Error: " + error.code + " " + error.message);
    }
  });
});
