# The toolbox: every check runs in here, on a laptop and in CI alike. Go 1.26 because the
# host builds with nixos-26.05's buildGoModule, which is Go 1.26; a newer toolchain here
# could accept code the host's build refuses.
FROM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c
# No .git inside the mount is guaranteed, and nothing reads the stamp.
ENV GOFLAGS=-buildvcs=false
