export function packageCommandSpawnOptions(command, platform = process.platform) {
  return { shell: platform === "win32" && /\.(?:cmd|bat)$/i.test(command) };
}
