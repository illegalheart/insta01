import fs from "node:fs";

const postFile = process.argv[2];

if (!postFile) {
  throw new Error("Usage: node scripts/publish-instagram.mjs <post-file.json>");
}

const post = JSON.parse(fs.readFileSync(postFile, "utf8"));

const imagePaths = post.image_paths ?? (post.image_path ? [post.image_path] : []);
const videoPath = post.video_path;
const mediaType = post.media_type ?? (videoPath ? "reel" : "post");

if (!post.caption) {
  throw new Error(`${postFile}: caption is required.`);
}

if (mediaType === "reel") {
  if (!videoPath) {
    throw new Error(`${postFile}: video_path is required for reel posts.`);
  }

  if (!videoPath.startsWith("videos/") || videoPath.includes("..")) {
    throw new Error(`${postFile}: video_path must point to a file inside videos/.`);
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`${postFile}: video file does not exist: ${videoPath}`);
  }
} else if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
  throw new Error(`${postFile}: image_path or image_paths are required.`);
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

function rawFileUrl(filePath) {
  const encodedImagePath = filePath.split("/").map(encodeURIComponent).join("/");
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
  const imageUrl = rawFileUrl(imagePath);
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

async function createReelContainer(filePath) {
  const videoUrl = rawFileUrl(filePath);
  console.log(`Creating reel media container for ${videoUrl}`);
  return graphRequest(`${instagramUserId}/media`, {
    method: "POST",
    body: new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      caption: post.caption,
      share_to_feed: post.share_to_feed === false ? "false" : "true",
      access_token: accessToken
    })
  });
}

async function waitForContainer(containerId) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const status = await graphRequest(
      `${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );

    if (status.status_code === "FINISHED") {
      return;
    }

    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Media container failed: ${JSON.stringify(status)}`);
    }

    if (attempt === 60) {
      throw new Error("Timed out waiting for the media container to finish.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

console.log(`Publishing ${postFile}`);

let publishContainer;

if (mediaType === "reel") {
  publishContainer = await createReelContainer(videoPath);
  await waitForContainer(publishContainer.id);
} else if (imagePaths.length === 1) {
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
