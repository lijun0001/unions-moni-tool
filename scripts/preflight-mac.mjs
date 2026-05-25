if (process.platform !== 'darwin') {
  console.error(
    `[build] macOS 安装包无法在 Windows 上本地构建（当前系统: ${process.platform}）。\n` +
      '请使用: npm run build:mac:experience:remote -- 1h\n' +
      '或在 Mac 上: npm run build:mac:experience -- 1y',
  )
  process.exit(1)
}
