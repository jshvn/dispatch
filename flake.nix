{
  description = "katoptra-dispatch: starts the katoptra mirrors' workflows on UTC slots";

  # The same release jshvn/jgrid.net builds its hosts from, so the host's lock can follow it.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: {
        default = pkgs.buildGoModule {
          pname = "katoptra-dispatch";
          version = "0.1.0";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./go.mod
              (lib.fileset.fileFilter (f: f.hasExt "go") ./.)
            ];
          };
          vendorHash = null; # standard library only
          # go test runs in buildGoModule's checkPhase; vet first, so either fails the host's build
          preCheck = "go vet ./...";
          # the module path's last element would name it `dispatch`
          postInstall = "mv $out/bin/dispatch $out/bin/katoptra-dispatch";
          meta.mainProgram = "katoptra-dispatch";
        };
      });

      nixosModules.default = import ./module.nix self;

      # The package (its tests included), and the module's two units rendered from a minimal
      # system: evaluation alone, no VM. ponytail: a nixosTest would boot the timer for real;
      # add one if a unit mistake ever gets past this.
      checks = forAll (
        pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          host = lib.nixosSystem {
            modules = [
              self.nixosModules.default
              {
                nixpkgs.hostPlatform = system;
                boot.loader.grub.enable = false;
                fileSystems."/" = {
                  device = "none";
                  fsType = "tmpfs";
                };
                system.stateVersion = "26.05";
                services.katoptra-dispatch = {
                  enable = true;
                  appIdFile = "/run/secrets/app-id";
                  privateKeyFile = "/run/secrets/private-key";
                  healthcheckUrlFile = "/run/secrets/healthcheck-url";
                };
              }
            ];
          };
          units = host.config.systemd.units;
        in
        {
          package = self.packages.${system}.default;
          # the rendered units, failing if ExecStart names anything but an executable
          module = pkgs.runCommand "katoptra-dispatch-units" { } ''
            service=${units."katoptra-dispatch.service".unit}/katoptra-dispatch.service
            exe=$(sed -n 's/^ExecStart=//p' "$service")
            test -x "$exe" || { echo "ExecStart $exe is not an executable" >&2; exit 1; }
            install -Dm644 -t $out "$service" ${units."katoptra-dispatch.timer".unit}/katoptra-dispatch.timer
          '';
        }
      );

      formatter = forAll (pkgs: pkgs.nixfmt-tree);
    };
}
