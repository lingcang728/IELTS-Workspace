# 产品网站

独立 Vite + React 站点，构建输出到仓库根 `site-dist/`。

开发：仓库根执行 `npm run dev:site`。构建：`npm run build:site`。
静态资源在 `public/`（logo、preview 从 `docs/assets/` 复制）。零 CDN，零 webfont。

部署：`.github/workflows/pages.yml` 把 `site-dist` 发到 Cloudflare Pages 项目 `ielts-workspace`。
需要 secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。
