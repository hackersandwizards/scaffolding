import { shellcheckMember, shellcheckPin, shellcheckRelease } from "./pinned-binary-assets.ts";
import { downloadPinnedAsset, extractPinnedBinary, pinnedBinary } from "./pinned-binary.ts";

export { pinnedBinaryScratch as shellcheckScratch } from "./pinned-binary.ts";

export function downloadShellcheckArchive(target: string, checksum: string) {
  return downloadPinnedAsset(
    `${shellcheckPin.base}/shellcheck-${shellcheckRelease}.${target}.tar.gz`,
    checksum,
  );
}

export function extractShellcheckBinary(scratch: string, archive: Buffer, checksum: string) {
  return extractPinnedBinary(scratch, archive, {
    tool: "shellcheck",
    label: shellcheckPin.label,
    asset: ["shellcheck.tar.gz", checksum, shellcheckMember],
  });
}

export const shellcheckBinary = (root: string) => pinnedBinary(root, "shellcheck", shellcheckPin);
