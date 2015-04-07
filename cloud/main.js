var utils = require("cloud/utils.js");

// Max distance between nearby users
var NEARBY_DISTANCE = 150;

Parse.Cloud.define("nearbyFriends", function(request, response) {
  var user = request.user;
  if (!user) {
    response.error("Request does not have an associated user.")
    return;
  }

  var userLocation = user.get("location");
  if (!userLocation) {
    response.error("User's location is not set.")
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
      var friendIDs = friends.map(function(friend) { return friend.id });
      var friendQuery = new Parse.Query(Parse.User);
      friendQuery.select("location", "name");
      friendQuery.containedIn("fbId", friendIDs);
      friendQuery.find({
        success: function(results) {
          var nearbyFriends = results.filter(function(friend) {
            var userLocation = user.get("location");
            var friendLocation = friend.get("location");
            var distance = utils.haversineDistance(
              userLocation.latitude, userLocation.longitude,
              friendLocation.latitude, friendLocation.longitude);
            return distance <= NEARBY_DISTANCE;
          });
          response.success(nearbyFriends);
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
