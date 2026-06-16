import fs from "node:fs";

const postFile = process.argv[2];

if (!postFile) {
  throw new Error("Usage: node scripts/publish-instagram.mjs <post-file.json>");
}

const post = JSON.parse(fs.readFileSync(postFile, "utf8"));

const imagePaths = post.image_paths ?? (post.image_path ? [post.image_path] : []);

if (!post.caption || !Array.isArray(imagePaths) || imagePaths.length === 0) {
  throw new Error(`${postFile}: caption and image_path or image_paths are required.`);
}

for (const imagePath of imagePaths) {
  if (!imagePath.startsWith("img/") || imagePath.includes("..")) {
    throw new Error(`${postFile}: image paths must point to files inside img/.`);
  }

  if (!fs.existsSync(imagePath)) {
    throw new Error(`${postFile}: image file does not exist: ${imagePath}`);
  }
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

function rawImageUrl(imagePath) {
  const encodedImagePath = imagePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repository}/${commitSha}/${encodedImagePath}`;
}

async function graphRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}/${path}`, options);
  const result = await response.json();

  if (!response.ok || result.error) {
    throw new Error(`Instagram API error: ${JSON.stringify(result)}`);
  }

  return result;
}

async function createImageContainer(imagePath, isCarouselItem = false) {
  const imageUrl = rawImageUrl(imagePath);
  console.log(`Creating media container for ${imageUrl}`);
  return graphRequest(`${instagramUserId}/media`, {
    method: "POST",
    body: new URLSearchParams({
      image_url: imageUrl,
      ...(isCarouselItem ? { is_carousel_item: "true" } : { caption: post.caption }),
      access_token: accessToken
    })
  });
}

async function waitForContainer(containerId) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const status = await graphRequest(
      `${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );

    if (status.status_code === "FINISHED") {
      return;
    }

    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Media container failed: ${JSON.stringify(status)}`);
    }

    if (attempt === 12) {
      throw new Error("Timed out waiting for the media container to finish.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

console.log(`Publishing ${postFile}`);

let publishContainer;

if (imagePaths.length === 1) {
  publishContainer = await createImageContainer(imagePaths[0]);
  await waitForContainer(publishContainer.id);
} else {
  const childContainers = [];

  for (const imagePath of imagePaths) {
    const child = await createImageContainer(imagePath, true);
    await waitForContainer(child.id);
    childContainers.push(child.id);
  }

  publishContainer = await graphRequest(`${instagramUserId}/media`, {
  method: "POST",
  body: new URLSearchParams({
    media_type: "CAROUSEL",
    children: childContainers.join(","),
    caption: post.caption,
    access_token: accessToken
  })
});

  await waitForContainer(publishContainer.id);
}

const published = await graphRequest(`${instagramUserId}/media_publish`, {
  method: "POST",
  body: new URLSearchParams({
    creation_id: publishContainer.id,
    access_token: accessToken
  })
});

console.log(`Instagram post published: ${published.id}`);
