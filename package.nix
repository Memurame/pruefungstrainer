{ lib, python3Packages, qt6, makeDesktopItem, copyDesktopItems }:

python3Packages.buildPythonApplication {
  pname = "pruefungstrainer";
  version = "0.5.0";
  pyproject = true;
  src = lib.cleanSource ./.;

  build-system = [ python3Packages.setuptools ];
  dependencies = with python3Packages; [ anthropic pyside6 pymupdf pydantic ];

  nativeBuildInputs = [ qt6.wrapQtAppsHook copyDesktopItems ];
  buildInputs = [ qt6.qtbase qt6.qtwayland ];

  # Qt-Umgebung (Plugins, Wayland) in den Python-Wrapper übernehmen
  dontWrapQtApps = true;
  preFixup = ''
    makeWrapperArgs+=("''${qtWrapperArgs[@]}")
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "pruefungstrainer";
      desktopName = "Prüfungstrainer";
      comment = "Probeprüfungen aus Obsidian-Notizen und PDFs";
      exec = "pruefungstrainer";
      icon = "accessories-dictionary";
      categories = [ "Education" ];
    })
  ];

  pythonImportsCheck = [ "pruefungstrainer" ];

  meta.mainProgram = "pruefungstrainer";
}
