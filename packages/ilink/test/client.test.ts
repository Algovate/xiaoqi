import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ILinkClient } from "../src/client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>) {
  return new ILinkClient({
    baseUrl: "https://api.example.com",
    token: "bot-token",
    cdnBaseUrl: "https://cdn.example.com/c2c",
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

describe("ILinkClient.sendImage", () => {
  it("uploads encrypted bytes and sends an image item", async () => {
    const data = Buffer.from("fake-png-payload");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ upload_param: "UPLOAD_PARAM" }))
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "x-encrypted-param": "ENCRYPTED_PARAM" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ message_id: "wx-123" }));

    const client = makeClient(fetchMock);
    const resp = await client.sendImage({
      toUserId: "wxid-user",
      contextToken: "ctx-token",
      data,
      mime: "image/png",
      clientId: "client-1",
    });

    expect(resp.message_id).toBe("wx-123");

    const uploadCall = fetchMock.mock.calls[0]!;
    expect(uploadCall[0]).toBe("https://api.example.com/ilink/bot/getuploadurl");
    const uploadBody = JSON.parse(uploadCall[1].body as string);
    expect(uploadBody).toMatchObject({
      media_type: 1,
      to_user_id: "wxid-user",
      rawsize: data.length,
      rawfilemd5: crypto.createHash("md5").update(data).digest("hex"),
      no_need_thumb: true,
      context_token: "ctx-token",
    });
    expect(uploadBody.filekey).toMatch(/^[0-9a-f]{32}$/);
    expect(uploadBody.aeskey).toMatch(/^[0-9a-f]{32}$/);
    expect(uploadBody.filesize % 16).toBe(0);
    expect(uploadBody.filesize).toBeGreaterThan(data.length);

    const cdnCall = fetchMock.mock.calls[1]!;
    expect(cdnCall[0]).toBe(
      "https://cdn.example.com/c2c/upload?encrypted_query_param=UPLOAD_PARAM&filekey=" +
        encodeURIComponent(uploadBody.filekey),
    );
    const cdnInit = cdnCall[1] as RequestInit;
    const ciphertext = Buffer.from(cdnInit.body as Uint8Array);
    expect(ciphertext.length).toBe(uploadBody.filesize);
    const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(uploadBody.aeskey, "hex"), null);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(plaintext.equals(data)).toBe(true);

    const sendCall = fetchMock.mock.calls[2]!;
    expect(sendCall[0]).toBe("https://api.example.com/ilink/bot/sendmessage");
    const sendBody = JSON.parse(sendCall[1].body as string);
    expect(sendBody.msg).toMatchObject({
      to_user_id: "wxid-user",
      client_id: "client-1",
      message_type: 2,
      message_state: 2,
      context_token: "ctx-token",
    });
    expect(sendBody.msg.item_list[0]).toEqual({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: "ENCRYPTED_PARAM",
          aes_key: Buffer.from(uploadBody.aeskey, "utf8").toString("base64"),
          encrypt_type: 1,
        },
        mid_size: ciphertext.length,
      },
    });
  });

  it("prefers upload_full_url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ upload_full_url: "https://cdn.example.com/direct" }))
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "x-encrypted-param": "ENC" } }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    const client = makeClient(fetchMock);
    await client.sendImage({
      toUserId: "u",
      contextToken: "c",
      data: Buffer.from("x"),
      mime: "image/png",
    });

    expect(fetchMock.mock.calls[1]![0]).toBe("https://cdn.example.com/direct");
  });

  it("sends a file item with the same encrypted upload flow", async () => {
    const data = Buffer.from("a,b\n1,2\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ upload_param: "FILE_PARAM" }))
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { "x-encrypted-param": "FILE_ENC" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ message_id: "wx-file" }));

    const client = makeClient(fetchMock);
    const resp = await client.sendFile({
      toUserId: "wxid-user",
      contextToken: "ctx-token",
      data,
      fileName: "export.csv",
      clientId: "file-1",
    });

    expect(resp.message_id).toBe("wx-file");
    const uploadBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(uploadBody.media_type).toBe(3);

    const sendBody = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(sendBody.msg.item_list[0]).toMatchObject({
      type: 4,
      file_item: {
        file_name: "export.csv",
        len: String(data.length),
        media: {
          encrypt_query_param: "FILE_ENC",
          aes_key: Buffer.from(uploadBody.aeskey, "utf8").toString("base64"),
          encrypt_type: 1,
        },
      },
    });
  });

  it("rejects unsupported mime types", async () => {
    const client = makeClient(vi.fn());
    await expect(
      client.sendImage({
        toUserId: "u",
        contextToken: "c",
        data: Buffer.from("x"),
        mime: "image/gif",
      }),
    ).rejects.toThrow("unsupported image mime");
  });
});
