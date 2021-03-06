import { createPhoenixSocket, createAbsintheSocket } from "./socket";
import { Presence } from "phoenix";
import { getInitialApiToken, fetchApiToken } from "./token";
import { insertTextAtCursor } from "./utils";
import * as AbsintheSocket from "@absinthe/socket";
import * as Background from "./background";
import autosize from "autosize";

const logEvent = eventName => (...args) =>
  console.log("[ports." + eventName + "]", ...args);

export const attachPorts = app => {
  // Start with the initial API token generated at page-load time.
  // This variable may get mutated over time as tokens expire.
  let token = getInitialApiToken();

  let socketParams = () => {
    return { Authorization: "Bearer " + token };
  };

  let phoenixSocket = createPhoenixSocket(socketParams);
  let absintheSocket = createAbsintheSocket(phoenixSocket);
  let channels = {};

  phoenixSocket.onOpen(() => {
    const payload = { type: "opened" };
    app.ports.socketIn.send(payload);
    logEvent("socketIn")(payload);
  });

  phoenixSocket.onError(() => {
    fetchApiToken()
      .then(newToken => {
        token = newToken;
      })
      .catch(() => {
        console.log("Token refresh failed");
      });
  });

  phoenixSocket.onClose(() => {
    const payload = { type: "closed" };
    app.ports.socketIn.send(payload);
    logEvent("socketIn")(payload);
  });

  const joinChannel = topic => {
    let channel = phoenixSocket.channel(topic, {});
    let presence = new Presence(channel);

    presence.onJoin((userId, current, presence) => {
      const callback = "onJoin";
      const data = { userId, current, presence };
      const payload = { callback, topic, data };

      app.ports.presenceIn.send(payload);
      logEvent("presenceIn")(payload);
    });

    presence.onLeave((userId, current, presence) => {
      const callback = "onLeave";
      const data = { userId, current, presence };
      const payload = { callback, topic, data };

      app.ports.presenceIn.send(payload);
      logEvent("presenceIn")(payload);
    });

    presence.onSync(() => {
      const callback = "onSync";

      const data = presence.list((userId, presence) => {
        return { userId, presence };
      });

      const payload = { callback, topic, data };

      app.ports.presenceIn.send(payload);
      logEvent("presenceIn")(payload);
    });

    channel.join();
    channels[topic] = channel;
  };

  const leaveChannel = topic => {
    let channel = channels[topic];
    if (!channel) return;

    channel.leave();
    delete channels[topic];
  };

  app.ports.updateToken.subscribe(newToken => {
    token = newToken;
    logEvent("updateToken")(token);
  });

  app.ports.socketOut.subscribe(args => {
    switch (args.method) {
      case "sendSubscription":
        const notifier = AbsintheSocket.send(absintheSocket, args);

        AbsintheSocket.observe(absintheSocket, notifier, {
          onResult: data => {
            data.type = "message";
            app.ports.socketIn.send(data);
            logEvent("socketIn")(data);
          }
        });

        break;

      case "cancelSubscription":
        const notifiers = absintheSocket.notifiers.filter(notifier => {
          return notifier.request.clientId == args.clientId;
        });

        notifiers.forEach(notifier => {
          AbsintheSocket.cancel(absintheSocket, notifier);
        });

        break;
    }

    logEvent("socketOut")(args);
  });

  app.ports.presenceOut.subscribe(arg => {
    const { method, topic } = arg;

    switch (method) {
      case "join":
        joinChannel(topic);
        break;

      case "leave":
        leaveChannel(topic);
        break;
    }

    logEvent("presenceOut")(arg);
  });

  app.ports.scrollTo.subscribe(arg => {
    const { containerId, anchorId, offset } = arg;

    requestAnimationFrame(() => {
      if (containerId === "DOCUMENT") {
        let container = document.documentElement;
        let anchor = document.getElementById(anchorId);
        if (!anchor) return;

        let rect = anchor.getBoundingClientRect();
        container.scrollTop = container.scrollTop + rect.top - offset;
      } else {
        let container = document.getElementById(containerId);
        let anchor = document.getElementById(anchorId);
        if (!(container && anchor)) return;

        container.scrollTop = anchor.offsetTop + offset;
      }

      logEvent("scrollTo")(arg);
    });
  });

  app.ports.scrollToBottom.subscribe(arg => {
    const { containerId } = arg;

    requestAnimationFrame(() => {
      if (containerId === "DOCUMENT") {
        let container = document.documentElement;
        container.scrollTop = container.scrollHeight;
      } else {
        let container = document.getElementById(containerId);
        if (!container) return;
        container.scrollTop = container.scrollHeight;
      }

      logEvent("scrollToBottom")(arg);
    });
  });

  app.ports.select.subscribe(id => {
    requestAnimationFrame(() => {
      let node = document.getElementById(id);
      node.select();
      logEvent("select")(id);
    });
  });

  app.ports.requestFile.subscribe(id => {
    let node = document.getElementById(id);
    if (!node) return;

    let file = node.files[0];
    if (!file) return;

    let reader = new FileReader();

    reader.onload = event => {
      let payload = {
        clientId: id,
        filename: file.name,
        contentType: file.type,
        size: file.size,
        contents: event.target.result
      };

      app.ports.receiveFile.send(payload);
      logEvent("file.receive")(payload);
    };

    reader.readAsDataURL(file);

    logEvent("requestFile")({ id });
  });

  if (Background.isSupported) {
    app.ports.pushManagerOut.subscribe(method => {
      switch (method) {
        case "getSubscription":
          Background.getPushSubscription().then(subscription => {
            const payload = {
              type: "subscription",
              subscription: JSON.stringify(subscription)
            };

            app.ports.pushManagerIn.send(payload);
            logEvent("pushManagerIn")(payload);
          });

          break;

        case "subscribe":
          Background.subscribe()
            .then(subscription => {
              const payload = {
                type: "subscription",
                subscription: JSON.stringify(subscription)
              };

              app.ports.pushManagerIn.send(payload);
              logEvent("pushManagerIn")(payload);
            })
            .catch(err => {
              console.error(err);
            });

          break;
      }

      logEvent("pushManagerOut")(method);
    });
  }

  app.ports.postEditorOut.subscribe(args => {
    let node = document.getElementById(args.id);
    if (!node) return;

    switch (args.command) {
      case "insertAtCursor":
        insertTextAtCursor(node, args.text);
        break;
    }
  });
};
