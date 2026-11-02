"use strict";
const { ethers } = require("ethers");
const { profileMessage, validateAvatar, validateBio, USERNAME_PATTERN, MAX_AVATAR_BYTES } = require("./profile");
function profileUi() {
  return { schema: "featheral.profile", version: 1, title: "Your World profile",
    description: "Your name, avatar and bio are public across Featheral. Saving requires a free wallet signature, not a transfer.",
    fields: [
      { name: "username", label: "Username", type: "text", required: true, minLength: 3, maxLength: 24,
        pattern: USERNAME_PATTERN.source, hint: "3-24 letters, numbers, _ . or -. Usernames are unique." },
      { name: "avatar", label: "Avatar", type: "image", accept: "image/png,image/jpeg,image/webp", size: 160, maxBytes: MAX_AVATAR_BYTES },
      { name: "bio", label: "Bio", type: "textarea", maxLength: 1000, hint: "A short public introduction. Do not include private information." },
    ], submitLabel: "Save profile" };
}
function prepareProfile(input) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  if (!input || typeof input.address !== "string" || !ethers.isAddress(input.address) || input.address.toLowerCase() === ethers.ZeroAddress)
    throw fail("Choose a valid wallet address.");
  if (typeof input.username !== "string" || !USERNAME_PATTERN.test(input.username)) throw fail("Choose a valid 3-24 character username.");
  const avatar = input.avatar ?? "", bio = input.bio ?? "";
  validateAvatar(avatar); validateBio(bio);
  const profile = { address: ethers.getAddress(input.address), username: input.username, avatar, bio, issuedAt: new Date().toISOString() };
  return { profile, message: profileMessage(profile) };
}
module.exports = { profileUi, prepareProfile };
