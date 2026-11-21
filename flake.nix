{
  description = "Prüfungstrainer – Probeprüfungen aus Obsidian-Notizen und PDFs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      packages = forAll (pkgs: rec {
        pruefungstrainer = pkgs.callPackage ./package.nix { };
        default = pruefungstrainer;
      });

      overlays.default = final: _prev: {
        pruefungstrainer = final.callPackage ./package.nix { };
      };

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.electron
          ];
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          # Das npm-Paket „electron“ (nur für die Typen) startet so das Electron aus nixpkgs
          ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin";
        };
      });
    };
}
