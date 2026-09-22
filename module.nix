# The scheduler as a NixOS service: a timer every five minutes starting one oneshot tick.
# It takes three file paths and knows nothing of where they come from; the host renders them
# (jshvn/jgrid.net: jgrid.secretTemplates into /run/secrets).
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.katoptra-dispatch;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
  # A string, never a Nix path: a path literal would copy the secret into the world-readable store.
  secretPath =
    description:
    lib.mkOption {
      type = lib.types.strMatching "/.+";
      inherit description;
    };
in
{
  options.services.katoptra-dispatch = {
    enable = lib.mkEnableOption "the katoptra workflow scheduler";
    appIdFile = secretPath "File holding the katoptra GitHub App's id.";
    privateKeyFile = secretPath "File holding the App's private key, PKCS#1 or PKCS#8 PEM.";
    healthcheckUrlFile = secretPath "File holding the scheduler's healthchecks.io ping URL.";
  };

  config = lib.mkIf cfg.enable {
    systemd.timers.katoptra-dispatch = {
      description = "katoptra-dispatch tick, every five minutes";
      wantedBy = [ "timers.target" ];
      # :02, :07 .. :42 .. :57, so the slot minute is always a tick. UTC whatever the host's
      # zone. No Persistent=: every tick reconciles from the state file, so a missed tick is
      # caught up by the next one.
      timerConfig.OnCalendar = "*:02/5 UTC";
    };

    systemd.services.katoptra-dispatch = {
      description = "fire due katoptra workflows, then ping the scheduler's healthcheck";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${package}/bin/katoptra-dispatch";
        TimeoutStartSec = "4min";
        DynamicUser = true;
        StateDirectory = "katoptra-dispatch";
        LoadCredential = [
          "app-id:${cfg.appIdFile}"
          "private-key:${cfg.privateKeyFile}"
          "healthcheck-url:${cfg.healthcheckUrlFile}"
        ];
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        ProtectHostname = true;
        ProtectClock = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictSUIDSGID = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        UMask = "0077";
      };
    };
  };
}
