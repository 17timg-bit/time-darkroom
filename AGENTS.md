# 时间暗房项目约定

- 延续双击 HTML 和 GitHub Pages 两种入口。发布时同步入口的版本元数据及资源版本参数，再运行 `node scripts/sync-entry.mjs` 和 `node scripts/sync-entry.mjs --check`。
- 每次完成一个可交付的优化版本，验证离线入口和相关功能，更新版本记录，提交到 `main` 并添加新的版本标签。将该提交和标签推送到 `origin`。
- GitHub Pages 发布源为该仓库 `main` 的根目录。待本次提交实际部署并从公开网页完成核验后，把网页链接和版本号发给用户。
