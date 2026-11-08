import type { OutboundFile } from "./outbound-file.js";

export interface CommandEffects {
  media?: OutboundFile;
  file?: OutboundFile;
}
