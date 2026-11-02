"use strict";
// Private responses and attachments are never cached on shared devices.
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); }
    catch (error) { console.error("Invalid App notification:", error); throw error; }
    const url = new URL(data?.url || "/", self.location.origin);
    if (url.origin !== self.location.origin) throw new Error("Untrusted notification target.");
    await self.registration.showNotification(data?.title || "Featheral App", {
      body: data?.body || "New workspace activity", icon: "/shared/logo-app.svg",
      badge: "/shared/logo-silver.svg", tag: "featheral-workspace", data: { url: url.href },
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || "/", self.location.origin);
    if (url.origin !== self.location.origin) throw new Error("Untrusted notification target.");
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(url.href); await client.focus(); return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
