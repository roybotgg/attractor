import type { Request } from "../types/request.js";
import type { ContentPart, ImagePart } from "../types/content-part.js";
import type { Message } from "../types/message.js";
import { isLocalFilePath, readImageFile } from "./file-image.js";

function isFileImagePart(part: ContentPart): part is ImagePart {
  return (
    part.kind === "image" &&
    typeof part.image.url === "string" &&
    isLocalFilePath(part.image.url)
  );
}

async function resolveContentPart(part: ContentPart): Promise<ContentPart> {
  if (!isFileImagePart(part)) {
    return part;
  }
  const url = part.image.url;
  if (url === undefined) {
    return part;
  }
  const result = await readImageFile(url);
  return {
    kind: "image",
    image: {
      data: result.data,
      mediaType: result.mediaType,
      detail: part.image.detail,
    },
  };
}

async function resolveMessage(message: Message): Promise<Message> {
  const hasFileImage = message.content.some(isFileImagePart);
  if (!hasFileImage) {
    return message;
  }
  const resolvedContent = await Promise.all(
    message.content.map(resolveContentPart),
  );
  return { ...message, content: resolvedContent };
}

/**
 * Pre-processes a Request, resolving any image parts with local file paths
 * (starting with /, ./, or ~/) into inline Uint8Array data.
 * Returns the original request if no file images are found.
 */
export async function resolveFileImages(request: Request): Promise<Request> {
  const hasAnyFileImage = request.messages.some((msg) =>
    msg.content.some(isFileImagePart),
  );
  if (!hasAnyFileImage) {
    return request;
  }
  const resolvedMessages = await Promise.all(
    request.messages.map(resolveMessage),
  );
  return { ...request, messages: resolvedMessages };
}
