{
  description = "Prüfungstrainer – Probeprüfungen aus Obsidian-Notizen und PDFs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      packages = forAll (pkgs: rec {
        pruefungstrainer = pkgs.callPackage ./package.nix { };
        default = pruefungstrainer;
      });

      overlays.default = final: prev: {
        pruefungstrainer = final.callPackage ./package.nix { };
      };

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          inputsFrom = [ self.packages.${pkgs.stdenv.hostPlatform.system}.default ];
          packages = [ pkgs.qt6.qtwayland ];
        };
      });
    };
}
