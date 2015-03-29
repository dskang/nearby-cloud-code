Parse.Cloud.define("nearbyFriends", function(request, response) {
  var user = request.user;
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
      friendQuery.containedIn("fbID", friendIDs);
      friendQuery.find({
        success: function(results) {
          // TODO: Only keep nearby friends
          console.log(results);
          response.success(results);
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
