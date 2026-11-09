"use strict";
(() => {
  const endpoint = "/api/v1/world/profile";
  async function request(path, body) {
    const response = await fetch(endpoint + path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.headers.get("content-type")?.includes("json")) throw new Error(`World profile API unavailable (HTTP ${response.status}).`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `World profile HTTP ${response.status}`);
    return data;
  }
  const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  function generateAvatar(seed, field) {
    let hash = 2166136261;
    for (const character of seed.toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    hash >>>= 0;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = field.size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");
    context.fillStyle = "#17251f"; context.fillRect(0, 0, field.size, field.size);
    context.fillStyle = `hsl(${hash % 360} 55% 65%)`;
    const cell = field.size / 7;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
      if (!(hash & (1 << (y * 3 + x)))) continue;
      context.fillRect((x + 1) * cell, (y + 1) * cell, cell, cell);
      context.fillRect((5 - x) * cell, (y + 1) * cell, cell, cell);
    }
    const avatar = canvas.toDataURL("image/png");
    if (atob(avatar.split(",")[1]).length > field.maxBytes) throw new Error("Generated avatar exceeds the profile size limit.");
    return avatar;
  }
  async function resize(file, field) {
    if (!field.accept.split(",").includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error("Choose a PNG, JPEG or WebP image up to 10 MiB.");
    const image = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = field.size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image processing is unavailable in this browser.");
      const size = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, field.size, field.size);
      let avatar = canvas.toDataURL("image/png");
      if (atob(avatar.split(",")[1]).length > field.maxBytes) avatar = canvas.toDataURL("image/jpeg", 0.8);
      if (atob(avatar.split(",")[1]).length > field.maxBytes) throw new Error("Avatar is too large after resizing. Choose a simpler image.");
      return avatar;
    } finally { image.close(); }
  }
  async function mount(root, options = {}) {
    const model = await request("/ui");
    if (model.schema !== "featheral.profile" || model.version !== 1 || !Array.isArray(model.fields)
      || model.fields.length !== 3 || model.fields.map(field => `${field.name}:${field.type}`).join(",") !== "username:text,avatar:image,bio:textarea")
      throw new Error("Unsupported World profile UX model.");
    let address = "", avatar = "", busy = false, generation = 0;
    const form = element("form"); form.className = "world-profile-form";
    const heading = element("h3", model.title), description = element("p", model.description);
    const fields = new Map(), preview = element("img"), message = element("p");
    message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
    preview.alt = "Avatar preview"; preview.width = preview.height = 64; preview.src = "/shared/logo-world.svg";
    form.append(heading, description);
    const report = error => { console.error("World profile:", error); message.textContent = error.message; };
    for (const field of model.fields) {
      const label = element(field.type === "image" ? "div" : "label", field.label), input = element(field.type === "textarea" ? "textarea" : "input");
      label.className = "world-profile-field";
      input.name = field.name;
      if (field.type === "image") {
        input.type = "file"; input.accept = field.accept; input.setAttribute("aria-label", "Upload avatar");
        label.append(preview);
        input.addEventListener("change", async () => {
          const file = input.files[0], current = generation; if (!file || busy) return;
          busy = true; input.disabled = true; submit.disabled = true;
          try {
            const result = await resize(file, field);
            if (generation !== current) throw new Error("Wallet changed. Select the avatar again.");
            avatar = result; preview.src = avatar; message.textContent = "Avatar ready. Save to publish.";
          } catch (error) { report(error); }
          finally { busy = false; input.disabled = !address; submit.disabled = !address; input.value = ""; }
        });
        const clear = element("button", "Choose another avatar"); clear.type = "button";
        clear.addEventListener("click", () => { if (!busy) input.click(); });
        label.append(clear);
        const generate = element("button", "Generate avatar"); generate.type = "button";
        generate.addEventListener("click", () => {
          if (busy || !address) return;
          try { avatar = generateAvatar(`${address}:${crypto.randomUUID()}`, field); preview.src = avatar; message.textContent = "Generated avatar ready. Save to publish."; }
          catch (error) { report(error); }
        });
        label.append(generate);
      } else {
        if (field.type === "text") { input.type = "text"; input.autocomplete = "nickname"; input.pattern = field.pattern; input.minLength = field.minLength; }
        else input.rows = 4;
        input.maxLength = field.maxLength; input.required = !!field.required;
      }
      label.append(input);
      if (field.hint) label.append(element("small", field.hint));
      form.append(label); fields.set(field.name, input);
    }
    const connect = element("button", "Connect wallet to set up profile"); connect.type = "button";
    const submit = element("button", model.submitLabel); submit.type = "submit"; submit.className = "primary";
    const wallet = element("small");
    form.append(wallet, connect, submit, message); root.replaceChildren(form);
    async function load(nextAddress, force = false) {
      if (!force && nextAddress?.toLowerCase() === address.toLowerCase()) return;
      const current = ++generation;
      if (nextAddress && !/^0x[0-9a-f]{40}$/i.test(nextAddress)) throw new Error("Invalid profile wallet address.");
      const data = nextAddress ? await request(`/${nextAddress}`) : { profile: null };
      if (current !== generation) return;
      address = nextAddress || ""; const profile = data.profile;
      avatar = profile?.avatar || (address ? generateAvatar(address, model.fields.find(field => field.name === "avatar")) : ""); fields.get("username").value = profile?.username || ""; fields.get("bio").value = profile?.bio || "";
      preview.src = avatar || "/shared/logo-world.svg"; wallet.textContent = address ? `Wallet: ${address}` : "";
      connect.hidden = !!address; submit.hidden = !address; message.textContent = "";
      for (const input of fields.values()) input.disabled = !address;
    }
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      try {
        if (!window.FeatheralWallet?.account) throw new Error("Shared wallet is still loading. Retry shortly.");
        const selected = await window.FeatheralWallet.account();
        document.getElementById("featheral-central-wallet")?.close();
        await load(selected.address);
        await options.onAccount?.(selected.address);
      } catch (error) { report(error); } finally { connect.disabled = false; }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy) return;
      busy = true; submit.disabled = true;
      const current = generation, owner = address;
      const input = { address: owner, username: fields.get("username").value.trim(), avatar, bio: fields.get("bio").value };
      for (const control of form.elements) control.disabled = true;
      try {
        if (!options.sign && !window.FeatheralWallet?.authenticate) throw new Error("Shared wallet is still loading. Retry shortly.");
        if (!avatar || !input.bio.trim()) throw new Error("Choose an avatar and write a profile description.");
        message.textContent = "Review and approve your public profile in the wallet.";
        const prepared = await request("/prepare", input);
        const authorization = options.sign ? { signature: await options.sign(prepared.message, owner) } : await window.FeatheralWallet.authenticate(selected => {
          if (selected.toLowerCase() !== owner.toLowerCase() || generation !== current) throw new Error("Wallet changed. Reconnect before saving this profile.");
          return prepared;
        });
        if (generation !== current) throw new Error("Profile account changed before saving.");
        const result = await request("", { ...prepared.profile, signature: authorization.signature });
        document.getElementById("featheral-central-wallet")?.close();
        await load(owner, true);
        const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("featheral-world-profile") : null;
        if (channel) { channel.postMessage({ type: "profile" }); channel.close(); }
        await options.onSaved?.(result.profile);
        message.textContent = "Profile saved.";
      } catch (error) { report(error); }
      finally {
        busy = false;
        for (const control of form.elements) control.disabled = false;
      }
    });
    await load(options.address || "", true);
    return { load };
  }
  window.FeatheralWorldProfile = { mount };
})();
