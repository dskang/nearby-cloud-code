Parse.Cloud.define("updateFriends", function(request, response) {
  Parse.Cloud.useMasterKey();
  var user = request.user;
  updateFriends(user).then(function() {
    response.success();
  }, function(error) {
    var message;
    if (error.type && error.code && error.message) {
      // Facebook error
      message = error.type + " (" + error.code + "): " + error.message;
    } else if (error.code && error.message) {
      // Parse error
      message = "(" + error.code + "): " + error.message;
    } else {
      message = error;
    }
    response.error(message);
  });
});

var updateFriends = function(user) {
  if (!user) {
    return Parse.Promise.error("Request does not have an associated user.");
  }

  var authData = user.get("authData");
  var accessToken = authData["facebook"]["access_token"];

  // Get Facebook friends
  return Parse.Cloud.httpRequest({
    url: "https://graph.facebook.com/me/friends",
    params: {
      access_token: accessToken,
      limit: 5000 // get all friends in one request
    }
  }).then(function(httpResponse) {
    var friends = httpResponse.data.data;
    var friendFbIds = friends.map(function(friend) { return friend.id });
    var friendQuery = new Parse.Query(Parse.User);
    friendQuery.containedIn("fbId", friendFbIds);
    return friendQuery.find();
  }, function(httpResponse) {
    var error = httpResponse.data.error;
    return Parse.Promise.error(error);
  }).then(function(friends) {
    var relation = user.relation("friends");
    for (var i = 0; i < friends.length; i++) {
      // Add friend as user's friend
      var friend = friends[i];
      relation.add(friend);

      // Add user as friend's friend
      var friendRelation = friend.relation("friends");
      friendRelation.add(user);
    }
    var saveFriends = Parse.Object.saveAll(friends);
    var saveUser = user.save();
    return Parse.Promise.when([saveFriends, saveUser]);
  });
};

exports.updateFriends = updateFriends;
