var facebook = require("cloud/facebook.js");

var express = require("express");
var app = express();

app.use(express.bodyParser());
app.listen();

var nearbyVerifyToken = "nearbyVerifyToken-411230442391289";
var callbackName = "fbFriendCallback";

app.get("/subscribe", function(req, res) {
  var callbackUrl = "https://nearbyapp.parseapp.com/" + callbackName;
  var fbAppId = "411230442391289";
  var fbAppSecret = "2d13093fc0cfdea3ec0fb36667fe10be";
  var accessToken = fbAppId + "|" + fbAppSecret;

  Parse.Cloud.httpRequest({
    method: "POST",
    url: "https://graph.facebook.com/411230442391289/subscriptions",
    params: {
      access_token: accessToken,
      object: "user",
      "callback_url": callbackUrl,
      fields: "friends",
      "verify_token": nearbyVerifyToken
    }
  }).then(function(httpResponse) {
    res.send(200);
  }, function(httpResponse) {
    var error = httpResponse.data.error;
    res.send(400, error);
  });
});

app.get("/" + callbackName, function(req, res) {
  var verifyToken = req.query["hub.verify_token"];
  var challenge = req.query["hub.challenge"];
  if (verifyToken !== nearbyVerifyToken) {
    res.send(400, "Error: Incorrect verify token.");
  } else {
    res.send(200, challenge);
  }
});

app.post("/" + callbackName, function(req, res) {
  Parse.Cloud.useMasterKey();
  // TODO: Verify X-Hub-Signature SHA1 signature
  var changedUsers = req.body.entry;
  var changedUsersFbIds = changedUsers.map(function(object) { return object["id"] });
  var query = new Parse.Query(Parse.User);
  query.containedIn("fbId", changedUsersFbIds);
  query.find().then(function(users) {
    var promises = [];
    for (var i = 0; i < users.length; i++) {
      var user = users[i];
      var updateFriendsPromise = facebook.updateFriends(user);
      promises.push(updateFriendsPromise);
    }
    return Parse.Promise.when(promises);
  }).then(function() {
    res.send(200);
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
    res.send(400, message);
  });
});
