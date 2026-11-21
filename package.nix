{
  lib,
  buildNpmPackage,
  electron,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
}:

buildNpmPackage {
  pname = "pruefungstrainer";
  version = "1.0.0";

  # Nur die Quelldateien – node_modules und Build-Ausgaben bleiben draussen
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./index.html
      ./tsconfig.json
      ./vite.config.ts
      ./scripts
      ./src
      ./shared
      ./electron
    ];
  };

  npmDepsHash = "sha256-61L0POL+IbKrEjPBdtylP/X8IA8b2tkFShv4GrZGMx0=";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  # Electron kommt aus nixpkgs, nicht aus npm
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  # npm run build → dist/ (Oberfläche) und dist-electron/ (Hauptprozess, alle Abhängigkeiten gebündelt)
  installPhase = ''
    runHook preInstall

    app=$out/share/pruefungstrainer/app
    mkdir -p $app $out/bin
    cp -r package.json dist dist-electron $app/

    makeWrapper ${lib.getExe electron} $out/bin/pruefungstrainer \
      --add-flags $app \
      --add-flags "--ozone-platform-hint=auto" \
      --add-flags "--enable-wayland-ime=true"

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "pruefungstrainer";
      desktopName = "Prüfungstrainer";
      comment = "Probeprüfungen aus Obsidian-Notizen und PDFs";
      exec = "pruefungstrainer";
      icon = "accessories-dictionary";
      startupWMClass = "pruefungstrainer";
      categories = [ "Education" ];
    })
  ];

  meta = {
    description = "Probeprüfungen aus Obsidian-Notizen und PDFs, Fragen per Claude generiert";
    platforms = lib.platforms.linux;
    mainProgram = "pruefungstrainer";
  };
}
