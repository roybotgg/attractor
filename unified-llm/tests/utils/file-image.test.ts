import { describe, test, expect } from "bun:test";
import { readImageFile, isLocalFilePath } from "../../src/utils/file-image.js";
import { resolveFileImages } from "../../src/utils/resolve-file-images.js";
import { join } from "node:path";
import type { Request } from "../../src/types/request.js";
import { Role } from "../../src/types/role.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("isLocalFilePath", () => {
  test("returns true for absolute paths", () => {
    expect(isLocalFilePath("/home/user/image.png")).toBe(true);
  });

  test("returns true for relative paths", () => {
    expect(isLocalFilePath("./images/photo.jpg")).toBe(true);
  });

  test("returns true for tilde paths", () => {
    expect(isLocalFilePath("~/Documents/pic.webp")).toBe(true);
  });

  test("returns false for http URLs", () => {
    expect(isLocalFilePath("https://example.com/image.png")).toBe(false);
  });

  test("returns false for data URIs", () => {
    expect(isLocalFilePath("data:image/png;base64,abc")).toBe(false);
  });
});

describe("readImageFile", () => {
  test("reads a PNG file and infers media type", async () => {
    const path = join(FIXTURES_DIR, "test.png");
    await Bun.write(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/png");
    expect(result.data).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  test("reads a JPEG file with .jpg extension", async () => {
    const path = join(FIXTURES_DIR, "test.jpg");
    await Bun.write(path, new Uint8Array([0xff, 0xd8]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/jpeg");
  });

  test("reads a JPEG file with .jpeg extension", async () => {
    const path = join(FIXTURES_DIR, "test.jpeg");
    await Bun.write(path, new Uint8Array([0xff, 0xd8]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/jpeg");
  });

  test("reads a GIF file", async () => {
    const path = join(FIXTURES_DIR, "test.gif");
    await Bun.write(path, new Uint8Array([0x47, 0x49, 0x46]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/gif");
  });

  test("reads a WebP file", async () => {
    const path = join(FIXTURES_DIR, "test.webp");
    await Bun.write(path, new Uint8Array([0x52, 0x49, 0x46, 0x46]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/webp");
  });

  test("reads an SVG file", async () => {
    const path = join(FIXTURES_DIR, "test.svg");
    await Bun.write(path, "<svg></svg>");

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/svg+xml");
  });

  test("uses octet-stream for unknown extensions", async () => {
    const path = join(FIXTURES_DIR, "test.bmp");
    await Bun.write(path, new Uint8Array([0x42, 0x4d]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("application/octet-stream");
  });

  test("handles uppercase extensions", async () => {
    const path = join(FIXTURES_DIR, "test.PNG");
    await Bun.write(path, new Uint8Array([0x89, 0x50]));

    const result = await readImageFile(path);
    expect(result.mediaType).toBe("image/png");
  });
});

describe("resolveFileImages", () => {
  test("returns original request when no file images exist", async () => {
    const request: Request = {
      model: "test",
      messages: [
        {
          role: Role.USER,
          content: [{ kind: "text", text: "hello" }],
        },
      ],
    };
    const result = await resolveFileImages(request);
    expect(result).toBe(request);
  });

  test("resolves file path images to inline data", async () => {
    const imgPath = join(FIXTURES_DIR, "resolve-test.png");
    await Bun.write(imgPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const request: Request = {
      model: "test",
      messages: [
        {
          role: Role.USER,
          content: [
            { kind: "text", text: "describe this" },
            { kind: "image", image: { url: imgPath } },
          ],
        },
      ],
    };

    const result = await resolveFileImages(request);

    expect(result).not.toBe(request);
    const imagePart = result.messages[0]?.content[1];
    expect(imagePart?.kind).toBe("image");
    if (imagePart?.kind === "image") {
      expect(imagePart.image.data).toEqual(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      );
      expect(imagePart.image.mediaType).toBe("image/png");
      expect(imagePart.image.url).toBeUndefined();
    }
  });

  test("preserves http URL images without modification", async () => {
    const request: Request = {
      model: "test",
      messages: [
        {
          role: Role.USER,
          content: [
            {
              kind: "image",
              image: { url: "https://example.com/photo.png" },
            },
          ],
        },
      ],
    };

    const result = await resolveFileImages(request);
    expect(result).toBe(request);
  });

  test("preserves detail field when resolving file images", async () => {
    const imgPath = join(FIXTURES_DIR, "detail-test.jpg");
    await Bun.write(imgPath, new Uint8Array([0xff, 0xd8]));

    const request: Request = {
      model: "test",
      messages: [
        {
          role: Role.USER,
          content: [
            { kind: "image", image: { url: imgPath, detail: "high" } },
          ],
        },
      ],
    };

    const result = await resolveFileImages(request);
    const imagePart = result.messages[0]?.content[0];
    if (imagePart?.kind === "image") {
      expect(imagePart.image.detail).toBe("high");
      expect(imagePart.image.mediaType).toBe("image/jpeg");
    }
  });
});
