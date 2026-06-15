import fs from "node:fs";

const postFile = process.argv[2];

if (!postFile) {
  throw new Error("Usage: node scripts/publish-instagram.mjs <post-file.json>");
}

const post = JSON.parse(fs.readFileSync(postFile, "utf8"));

if (!post.caption || !post.image_path) {
  throw new Error(`${postFile}: caption and image_path are required.`);
}

if (!post.image_path.startsWith("img/") || post.image_path.includes("..")) {
  throw new Error(`${postFile}: image_path must point to a file inside img/.`);
}

if (!fs.existsSync(post.image_path)) {
  throw new Error(`${postFile}: image file does not exist: ${post.image_path}`);
}

const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
const instagramUserId = process.env.INSTAGRAM_USER_ID;
const apiVersion = process.env.META_API_VERSION;
const repository = process.env.GITHUB_REPOSITORY;
const commitSha = process.env.GITHUB_SHA;

if (!accessToken || !instagramUserId || !apiVersion || !repository || !commitSha) {
  throw new Error(
    "INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID, META_API_VERSION, GITHUB_REPOSITORY, and GITHUB_SHA are required."
  );
}

const baseUrl = `https://graph.instagram.com/${apiVersion}`;
const encodedImagePath = post.image_path.split("/").map(encodeURIComponent).join("/");
const imageUrl = `https://raw.githubusercontent.com/${repository}/${commitSha}/${encodedImagePath}`;

async function graphRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}/${path}`, options);
  const result = await response.json();

  if (!response.ok || result.error) {
    throw new Error(`Instagram API error: ${JSON.stringify(result)}`);
  }

  return result;
}

console.log(`Publishing ${postFile} with ${imageUrl}`);

const container = await graphRequest(`${instagramUserId}/media`, {
  method: "POST",
  body: new URLSearchParams({
    image_url: imageUrl,
    caption: post.caption,
    access_token: accessToken
  })
});

for (let attempt = 1; attempt <= 12; attempt += 1) {
  const status = await graphRequest(
    `${container.id}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
  );

  if (status.status_code === "FINISHED") {
    break;
  }

  if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
    throw new Error(`Media container failed: ${JSON.stringify(status)}`);
  }

  if (attempt === 12) {
    throw new Error("Timed out waiting for the media container to finish.");
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
}

const published = await graphRequest(`${instagramUserId}/media_publish`, {
  method: "POST",
  body: new URLSearchParams({
    creation_id: container.id,
    access_token: accessToken
  })
});

console.log(`Instagram post published: ${published.id}`);
