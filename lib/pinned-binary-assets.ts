export type PinnedAsset = readonly [
  name: string,
  checksum: string,
  member?: string,
  executableChecksum?: string,
];

export type BinaryRelease = {
  label: string;
  release: string;
  base: string;
  assets: ReadonlyMap<string, PinnedAsset>;
};

function githubRelease(repo: string, release: string) {
  return `https://github.com/${repo}/releases/download/${release}`;
}

export const shellcheckRelease = "v0.11.0";
const shellcheckHashes = new Map([
  [
    "darwin.aarch64",
    {
      archive: "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
      binary: "61c17246d69f012cd458ae82f244c46023dac75d1b69733ca1cc7d28fb270fd7",
    },
  ],
  [
    "darwin.x86_64",
    {
      archive: "c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51",
      binary: "2589be755bb115f4421b8271eb7c08df1e03729f00350c1e4cf53b4a0bf9c2df",
    },
  ],
  [
    "linux.aarch64",
    {
      archive: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
      binary: "127f13925eadd52c341bca0ebaf9ab0dbd78c6468f30a8f262a528bf8de47546",
    },
  ],
  [
    "linux.x86_64",
    {
      archive: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
      binary: "4da528ddb3a4d1b7b24a59d4e16eb2f5fd960f4bd9a3708a15baddbdf1d5a55b",
    },
  ],
]);

export const shellcheckMember = `shellcheck-${shellcheckRelease}/shellcheck`;

export const shellcheckPin: BinaryRelease = {
  label: "ShellCheck",
  release: shellcheckRelease,
  base: githubRelease("koalaman/shellcheck", shellcheckRelease),
  assets: new Map(
    Array.from(shellcheckHashes, ([target, hashes]) => [
      target,
      [
        `shellcheck-${shellcheckRelease}.${target}.tar.gz`,
        hashes.archive,
        shellcheckMember,
        hashes.binary,
      ],
    ]),
  ),
};

export const ruffPin: BinaryRelease = {
  label: "Ruff",
  release: "0.17.6",
  base: githubRelease("astral-sh/ruff", "0.17.6"),
  assets: new Map([
    [
      "darwin.aarch64",
      [
        "ruff-aarch64-apple-darwin.tar.gz",
        "72a886253072cd1bb6a5978a33a5a7add848ee315a8b0f1589f164a11c26328d",
        "ruff-aarch64-apple-darwin/ruff",
        "d0ee7b66ee25be92e61ac281f1ea31a012b5b62608297c15c2cb96a4fa575eb5",
      ],
    ],
    [
      "darwin.x86_64",
      [
        "ruff-x86_64-apple-darwin.tar.gz",
        "5e554db9c2663e1b84911446cab0a9fd4aa6d9a14dc751a4869d2f92209dcb70",
        "ruff-x86_64-apple-darwin/ruff",
        "57dc8a898d643c48115e13fd5ce3499b171ead51a988d8de0c5f8d8f3dfc3c6e",
      ],
    ],
    [
      "linux.aarch64",
      [
        "ruff-aarch64-unknown-linux-musl.tar.gz",
        "dc96feed20df78c9498106cd2483e710a4db8b00b13a75954b2a37bc9f61e65c",
        "ruff-aarch64-unknown-linux-musl/ruff",
        "8694a23f9dcc93390097b3edd9a62168d49b823c99a65205dd5e1267dd3a0184",
      ],
    ],
    [
      "linux.x86_64",
      [
        "ruff-x86_64-unknown-linux-musl.tar.gz",
        "3c8d5a4264558df8b1587ce32409b658069b6a1ef5bfe4d279431eb1db62a183",
        "ruff-x86_64-unknown-linux-musl/ruff",
        "427390db027ec004b71f15f62103c610e2219f284238eed0d42085b16a0085ea",
      ],
    ],
  ]),
};

export const tflintPin: BinaryRelease = {
  label: "TFLint",
  release: "v0.66.0",
  base: githubRelease("terraform-linters/tflint", "v0.66.0"),
  assets: new Map([
    [
      "darwin.aarch64",
      [
        "tflint_darwin_arm64.zip",
        "859b26af07ead7e65cee7eec9d050b2e2571dc28395b7a39191cae088cd67803",
        "tflint",
        "8db8f965e4f8cf9d39d564b6e71865bfcd006bfd4316caddd5e0d47da8d95703",
      ],
    ],
    [
      "darwin.x86_64",
      [
        "tflint_darwin_amd64.zip",
        "e2d98b60adb2602a252ee9efb036e237edf13c8fda91f4d513d3357e1a01a889",
        "tflint",
        "f835a0236a0af77bcd92e9839c6fe572f4308fca6be40806a107a942dc34bbcb",
      ],
    ],
    [
      "linux.aarch64",
      [
        "tflint_linux_arm64.zip",
        "1105a0a5ddee7cdac7957a3475571a946b839192ea1bc0c722c6c4686001067e",
        "tflint",
        "fe394b458221d90ddfe962cefb5e90b9a2a1777a44bc90955adb46006090047a",
      ],
    ],
    [
      "linux.x86_64",
      [
        "tflint_linux_amd64.zip",
        "22be11cadc25cd02401e94c0ccc91aa63467debb8485c2a755d98f4c0a9d1e2e",
        "tflint",
        "8f33a3e34dd83cd4bf43646f2e8492d4d5bb8941036a9ae517b611e56004e70d",
      ],
    ],
  ]),
};

export const terraformPin: BinaryRelease = {
  label: "Terraform",
  release: "1.17.2",
  base: "https://releases.hashicorp.com/terraform/1.17.2",
  assets: new Map([
    [
      "darwin.aarch64",
      [
        "terraform_1.17.2_darwin_arm64.zip",
        "da0c7ef278a911347862758e7573a5907365e66485c2637cf5c217c5e227992e",
        "terraform",
        "eeaa5652e0ccb6426360655725d3bafe8bbc2081fb42b2cd531733588039b347",
      ],
    ],
    [
      "darwin.x86_64",
      [
        "terraform_1.17.2_darwin_amd64.zip",
        "66b472dcc36cf770d83757ed4d002c476174842c05c68637b40a7e99519cf3e1",
        "terraform",
        "907c58c510e981f70d625d505a2a13d8c3ff6a23a7fefbb3927be5abf47af92f",
      ],
    ],
    [
      "linux.aarch64",
      [
        "terraform_1.17.2_linux_arm64.zip",
        "858e08c181a76b6b223e8c767a8e983922eebe2d062db949a2de66ce040c368c",
        "terraform",
        "d54e1202dac657f53fa5982c3481e6f001fafce7ee505dfaf3466d5e934f44e1",
      ],
    ],
    [
      "linux.x86_64",
      [
        "terraform_1.17.2_linux_amd64.zip",
        "e6f16b2f0b137ee5729caa8c4e79a3bae4ee261acd198a1fcfa8584a6296605b",
        "terraform",
        "dbfef0be43ba2117481be510d3b83a2d8cdfa6ae7ec69c5aeb04b3947956ff7e",
      ],
    ],
  ]),
};

export const hadolintPin: BinaryRelease = {
  label: "Hadolint",
  release: "v2.15.1",
  base: githubRelease("hadolint/hadolint", "v2.15.1"),
  assets: new Map([
    [
      "darwin.aarch64",
      ["hadolint-macos-arm64", "5c09f3213f8e40406abe048233d985eebef336d4a6a20021be47fadb6cf480a2"],
    ],
    [
      "darwin.x86_64",
      ["hadolint-macos-x86_64", "ffe9bb18b23d5ed1eae50237aecdbb523d016e96da0bd4e7aa432040acfc3fde"],
    ],
    [
      "linux.aarch64",
      ["hadolint-linux-arm64", "f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d"],
    ],
    [
      "linux.x86_64",
      ["hadolint-linux-x86_64", "c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507"],
    ],
  ]),
};

export const actionlintPin: BinaryRelease = {
  label: "actionlint",
  release: "v1.7.12",
  base: githubRelease("rhysd/actionlint", "v1.7.12"),
  assets: new Map([
    [
      "darwin.aarch64",
      [
        "actionlint_1.7.12_darwin_arm64.tar.gz",
        "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
        "actionlint",
        "8db11704dc296f096216db4db65d86cd7f0ebfdf4c38453a1da276b137b88388",
      ],
    ],
    [
      "darwin.x86_64",
      [
        "actionlint_1.7.12_darwin_amd64.tar.gz",
        "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
        "actionlint",
        "d1f7cee75ae2873609bd9567b4600bebc5315a5e733e73202987a44fafdd53b2",
      ],
    ],
    [
      "linux.aarch64",
      [
        "actionlint_1.7.12_linux_arm64.tar.gz",
        "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
        "actionlint",
        "ac0323433c2853ec3fb978c611430c5b3dc5d43c58d1a1ec031b00ab572beb60",
      ],
    ],
    [
      "linux.x86_64",
      [
        "actionlint_1.7.12_linux_amd64.tar.gz",
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        "actionlint",
        "c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4",
      ],
    ],
  ]),
};
