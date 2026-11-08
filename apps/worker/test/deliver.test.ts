import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, Logger, MessageRow } from "@xiaoqi/core";

const { sendImageMock, sendFileMock } = vi.hoisted(() => ({
  sendImageMock: vi.fn(),
  sendFileMock: vi.fn(),
}));

vi.mock("../src/send.js", () => ({
  sendImage: sendImageMock,
  sendFile: sendFileMock,
}));

const { deliverAttachments } = await import("../src/deliver.js");

const config = {} as AppConfig;
const logger = { warn: vi.fn() } as unknown as Logger;
const msg = { id: 1 } as MessageRow;

beforeEach(() => {
  sendImageMock.mockReset().mockResolvedValue(undefined);
  sendFileMock.mockReset().mockResolvedValue(undefined);
});

describe("deliverAttachments", () => {
  it("sends both media and file, then removes local files", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xiaoqi-deliver-"));
    try {
      const media = path.join(dir, "a.png");
      const file = path.join(dir, "b.py");
      await fsp.writeFile(media, "x");
      await fsp.writeFile(file, "y");
      const result = await deliverAttachments(
        { config, logger },
        "run",
        msg,
        {
          media: { path: media, mime: "image/png", filename: "a.png" },
          file: { path: file, mime: "text/x-python", filename: "b.py" },
        },
      );
      expect(result).toEqual({ errorCode: null, notes: [] });
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      expect(sendFileMock).toHaveBeenCalledTimes(1);
      await expect(fsp.stat(media)).rejects.toBeTruthy();
      await expect(fsp.stat(file)).rejects.toBeTruthy();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed image but still sends the file", async () => {
    sendImageMock.mockRejectedValueOnce(new Error("boom"));
    const result = await deliverAttachments(
      { config, logger },
      "run",
      msg,
      {
        media: { path: "/tmp/missing.png", mime: "image/png", filename: "a.png" },
        file: { path: "/tmp/missing.py", mime: "text/x-python", filename: "b.py" },
      },
    );
    expect(result.errorCode).toBe("IMAGE_SEND_FAILED");
    expect(result.notes[0]).toContain("图片");
    expect(sendFileMock).toHaveBeenCalledTimes(1);
  });
});
