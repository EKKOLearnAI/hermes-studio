#!/bin/bash

install_dir='/opt/${sanitizedProductName}'
compat_dir='/opt/${executable}'

# Delete the link to the binary.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' "$compat_dir/${executable}" 2>/dev/null || true
    update-alternatives --remove '${executable}' "$install_dir/${executable}" 2>/dev/null || true
else
    rm -f '/usr/bin/${executable}'
fi

if [ -L "$compat_dir" ] && [ "$(readlink "$compat_dir")" = "$install_dir" ]; then
    rm -f "$compat_dir"
fi
