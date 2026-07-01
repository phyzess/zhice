import type { MaterialManifest } from "@zhice/core";

const imageHeaders = {
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  referer: "https://basic.smartedu.cn/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36",
};

export async function fetchPageImage(
  manifest: MaterialManifest,
  page: number,
): Promise<Uint8Array> {
  return fetchPageImageByBasePath(manifest.imageBasePath, page);
}

export async function fetchPageImageByBasePath(
  imageBasePath: string,
  page: number,
): Promise<Uint8Array> {
  const preferred = ((page - 1) % 3) + 1;
  const hosts = [preferred, ...[1, 2, 3].filter((index) => index !== preferred)];
  let lastError: unknown;
  for (const hostIndex of hosts) {
    const url = getImageUrlForHost(imageBasePath, page, hostIndex);
    try {
      const response = await fetch(url, { headers: imageHeaders });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error("not a jpeg");
      }
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`第 ${page} 页下载失败：${String(lastError)}`);
}

export async function proxyPageImage(imageBasePath: string, page: number): Promise<Response> {
  try {
    const bytes = await fetchPageImageByBasePath(imageBasePath, page);
    return new Response(bytes, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch {
    return Response.json({ error: `第 ${page} 页图片读取失败，请稍后重试。` }, { status: 502 });
  }
}

function getImageUrlForHost(basePath: string, page: number, hostIndex: number): string {
  return `https://r${hostIndex}-ndr.ykt.cbern.com.cn${basePath}/${page}.jpg`;
}
