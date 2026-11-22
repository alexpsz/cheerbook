# 启用免账号投稿

制作页和应援文件仍由现有 Cloudflare Pages 项目发布。投稿 API 是独立的 Cloudflare Worker，仅使用同域 `/api/submissions` 和 `/api/submissions/config`。GitHub 上的 PR 是唯一入库入口。实际启用前，保存到本机、自行提 PR 和在映场中打开都可继续使用。

## 1. 安装专用 GitHub App

在 GitHub 的 Settings → Developer settings → GitHub Apps → New GitHub App 注册一个仅此账号安装的 App，主页填写 CheerBook 正式首页。关闭 Webhook 和用户授权，不需要回调、客户端密钥或用户令牌。Repository permissions 仅给 Contents 和 Pull requests 各 Read and write，Metadata 保留默认只读。无组织、账号或其他仓库权限。安装时选 Only select repositories，只勾选 `alexpsz/cheerbook`。记录设置页的 App ID 和安装页面地址中的 Installation ID。在 App 的 Private keys 下 Generate a private key，将下载的 PEM 保存在自己的密钥管理位置。[GitHub 注册说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

机器人仅向专用投稿分支写入文件、创建 PR。不给 App 绕过 main 保护的权限。GitHub 的 Contents 写入权限按仓库授权；保护 main 需要同时在仓库侧配置。机器人署名不能用来认定本次修改的原作者。可选 GitHub 登录将来可另外接入，当前没有回调或账号绑定。

## 2. 创建 Turnstile

在 Cloudflare 控制台打开 Turnstile，添加 Managed 类型的 widget，允许的生产 hostname 填 `cheerbook.kozueginko.com`。保留 site key 和 secret。制作页使用公开 site key；后端使用 secret 请求 Siteverify，同时核对 action `submit_chart` 和上述 hostname。在真实域名使用生产密钥。测试凭据只用于独立测试环境。[Cloudflare 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## 3. 部署 Worker 并连接站点

1. 在仓库根运行 `npm ci --prefix worker --ignore-scripts`、`npm test`、`npm run check`、`npm run site`。用 Wrangler 4.36 或更新版运行 `wrangler deploy --dry-run`，检查入口指向 `worker/index.js`，rate-limit binding 为 `SUBMISSION_RATE_LIMITER`。锁定的 Worker 依赖是运行 JSON Schema 2020-12 的校验器。
2. 在 Cloudflare Workers & Pages 创建名称为 `cheerbook-submissions` 的 Worker。在该 Worker 的 Settings → Variables and Secrets 中，将 `TURNSTILE_SECRET` 与整个多行 PEM `GITHUB_PRIVATE_KEY` 分别设为 **Secret**；`TURNSTILE_SITE_KEY`、`GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID` 设为变量。不要把 PEM、secret、安装令牌填入 GitHub PR、聊天、仓库或 Pages 的前端环境。
3. 检查仓库 `wrangler.jsonc` 的 zone 和路由，确认限流 namespace ID 在自己的账号内独立使用，然后由维护者从这个提交执行 `wrangler deploy`。配置只接管 `cheerbook.kozueginko.com/api/submissions*`，保留既有 Pages 自定义域名、静态构建和 DNS。Worker 每个 Cloudflare 机房对同一来源 IP 约限 5 次/分钟，这个计数不跨机房强一致。[限流说明](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
4. 先合入并启用新的检查与三档合并策略，再开放投稿入口。核对 main 的保护设置，将 `check` 和 `cheerbook/review-policy` 设为必需状态检查（来源 GitHub Actions），并要求合并前跟上最新 main，保证同时到达的投稿仍基于当前目录审核。合并后没有工作流写回 main：索引由 Cloudflare Pages 构建网站时生成，`contributors.json` 与通用 MIX 的并入由维护者手动运行“更新记录”、从它推送的 `records/` 分支发起 PR 并核准合并。因此规则的绕过名单只放仓库管理员（维护者自己的修改照常直接推送），不给 GitHub Actions 或投稿 App 绕过能力；规则只作用于 main，投稿 App 仍可创建 `submission/` 分支。若给所有 PR 一律要求人工 review，新文件将无法按第一档自动入库；原作者或维护者的人工审批按修改类 PR 单独处理。
5. 对需人工合并的 PR，原 GitHub 作者或维护者新发一条独立评论 `/cheerbook approve <该 PR 最新的完整提交 SHA>`。工作流以 GitHub 数字账号核对，旧 SHA 或编辑过的评论不能批准新版本。无账号、无可靠作者记录或通用 MIX 由仓库维护者核准。该状态满足后再手动合并。
6. GET `https://cheerbook.kozueginko.com/api/submissions/config` 应返回公开 site key。用无 GitHub 登录的浏览器打开制作页，确认人机验证、投稿结果及返回的 PR 链接均可见。日后停用可移除该 Worker 路由，保留 Pages 和已有 PR；泄露时先撤销相应 App 私钥或 Turnstile secret，再通过平台配置替换。

## 4. 如何验收

离线检查使用编造的歌曲和注入的网络响应，不创建公开投稿。发布前可在维护者控制的测试部署和测试仓库做真实演练；代码中的正式仓库、域名及前端 PR 链接校验必须同时改成测试目标，测试 App 仅装测试仓库。真实正式站验收使用自愿投稿且可公开的内容。

| 场景 | 预期 |
| --- | --- |
| 无账号，合法文件，通过验证 | 显示可免登录查阅的 PR 链接。正常重试指向同一 PR。 |
| 非法格式、歌词键或与该录音参考歌词重合 | 显示原因，GitHub 中不产生投稿。 |
| 文件超过 512 KiB、挑战未通过或已过期、触发限流 | 显示可理解的失败与重试提示，原草稿可继续编辑。 |
| 含自由文字但没有能核对的参考歌词 | 创建草稿 PR，由维护者核对。网页不上传本机歌词及音频。 |
| 只新增时间轴或艺人专属 MIX | 普通 PR 全部检查通过、最新基准无冲突后自动合并；网站重新构建后，首页与 `index.json` 中出现该文件。 |
| 更新已有投稿、改名、删除，或涉及通用 MIX | 等原作者或维护者核准后人工合并；通用 MIX 一律人工合并。 |

对照一首歌时，先在网页本地用同一录音试听；投稿后保存 PR 链接。入库后用另一台 Mac 在映场按歌找到、导入并核对首段和后段的 MIX 时点。反馈可直接附 PR 链接、映场构建号与出现问题的时间点。
