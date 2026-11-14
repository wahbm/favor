# 阿里云 ECS 部署与恢复

## 当前部署

- 仓库：`wahbm/favor`，main分支推送及手动触发自动发布；PR仅构建和测试。
- 入口：`https://8.130.116.192/mosshqq/favor/`，复用现有有效HTTPS证书和Nginx。
- Ubuntu24.04 x64，主机Node22、共享MariaDB10.11；独立数据库`favor`及仅限本机访问的用户。
- 服务：`favor.service`，无登录服务用户`favor`，仅监听`127.0.0.1:3001`。
- 发布根目录：`/var/www/mosshqq/favor`。根目录必须root:root0755；只有incoming、releases由deploy持有，防止通过状态文件或current软链接扩大sudo权限。
- 环境文件：`/etc/favor/favor.env`，root:favor0640；密码在服务器生成，不进入仓库、CI或聊天。
- Nginx：独立`/etc/nginx/snippets/favor.locations.conf`，只在现有HTTPS站点精确include，保留其他项目路由。
- 权限：组织变量`DEPLOY_HOST/PORT/USER/KNOWN_HOSTS`，组织选定仓库密钥`SSH_PRIVATE_KEY`，仓库变量`DEPLOY_PATH=/var/www/mosshqq/favor`。

`.github/workflows/deploy-ecs.yml` 在Ubuntu CI上执行真实数据库测试、子路径构建及Linux生产依赖安装。上传带校验和的运行包，经严格SSH主机校验发布；不在ECS安装开发依赖，不新增Docker或另一套数据库。生产应用的构建与运行基础路径必须分别是`PUBLIC_BASE_PATH=/mosshqq/favor/`、`BASE_PATH=/mosshqq/favor`。

`bootstrap-ecs.sh`是首次初始化脚本，**不可直接重复执行**：遇到已有数据库、账号、目录或配置立即停止，先由运维核实，不覆盖已有项目。它安装根用户持有的`favor-release`辅助程序，deploy只可调用这一程序，不获得广泛sudo权限。

`favor-release <唯一版本号>`串行执行数据库备份、迁移、current原子切换、重启和本机健康检查。失败保留诊断，并回切已验证的上一版本；首次失败停止新服务。`favor-release smoke`以服务账号验证真实注册、登录、记账持久性与导出，然后按随机验收账号ID清理自己的临时数据，不触碰其他账号。`favor-release prune`只在CI公网HTTPS健康与页面校验通过后调用，仅清理本项目的构建release，保留当前和一个已验证旧版。数据库和备份不放在release目录。

每次发布的数据库备份位于`/var/backups/favor/pre-<版本号>.sql`，仅root可读。当前未设置定时备份、异地保存或自动清理数据库备份；运维应监测备份目录磁盘用量并根据保留策略人工维护。Nginx初始配置备份同样保存在此目录。应用日志使用journalctl，避免记录邀请链接查询参数。

## 通用部署和恢复说明

以下是其他服务器或故障恢复时的参考步骤，路径和服务名需与上方当前部署保持一致。

部署模板和脚本需要运维先审阅；不得将真实凭据写入仓库。使用现有共享 MariaDB、主机 Nginx 和独立 systemd 服务，不额外启动 Docker、Redis 或第二套数据库。

## 部署前核实

- 核实 ECS 的操作系统、架构、Node.js路径、MariaDB版本、RAM、swap、磁盘、现有 Nginx 站点、服务和占用端口；确认 `/var/www/mosshqq/favor`、`favor.service`、数据库与用户名未被其他项目使用。模板面向 Linux x64 / Node 22，其他架构应在匹配的 Linux CI 上重新打包原生依赖。
- 使用尚未占用的专用域名并配置 DNS、有效HTTPS证书。`APP_ORIGIN` 精确匹配HTTPS来源，子路径另由`BASE_PATH`配置。不要使用HTTP部署生产登录页。
- 确认是否需要自动备份及异地保存；默认不创建任何计划任务。每次迁移前必须有可验证的备份，首次空库也应导出结构。
- 运行模型为一份 Node 服务；空闲内存预留约100–200MB，密码哈希并发时可能更高。运行包预计几十到数百MB，保留当前和一个已验证版本；须在目标机器实测，不将估算当作验收数据。

## 数据库与环境

复用主机 MariaDB，新建专用 `utf8mb4` 数据库及仅允许本机访问、只拥有该库权限的应用用户。先确认名字未被占用。数据库仅监听127.0.0.1，安全组不开放3306或应用3000端口。

将 `production.env.example` 复制到服务器 `/etc/favor/favor.env`，由管理员在服务器安全编辑实际值：

- `DATABASE_URL`：专用数据库用户；密码中保留字符需URL编码。
- `APP_ORIGIN`：实际HTTPS域名，不带尾部路径。
- `HOST=127.0.0.1`、`PORT=3001`：若端口已被占用，修改应用、Nginx及发布脚本健康检查端口。

创建专用无登录服务用户 `favor`。环境文件由 root 持有、favor 组可读（0640），`/etc/favor` 为0750；不要把该文件放入仓库、CI运行包或聊天。数据保留在MariaDB，不放在release目录。依赖包含Argon2原生绑定，在CI安装，禁止把macOS的node_modules上传Linux。

## 构建与发布

`.github/workflows/deploy-ecs.yml` 在PR、main推送和手动触发时运行真实数据库测试及构建，生成 `favor-linux-x64.tgz`；只有main分支的推送和手动触发可以进入部署。

也可在匹配服务器的Linux构建机执行：

```sh
npm ci
npm run build
TEST_DATABASE_URL='mysql://USER:PASSWORD@127.0.0.1:3306/favor_test' npm test
npm prune --omit=dev
tar -czf favor-linux-x64.tgz dist node_modules package.json package-lock.json deploy/smoke-production.mjs
```

生产部署按以下顺序执行（需要具有对应权限的运维人员）：

1. 在确认无路径冲突后创建 `/var/www/mosshqq/favor/releases/<唯一版本号>/`，将运行包解压至该目录，检查 `dist/server/index.js`、`dist/server/migrate.js`、`dist/client/index.html` 和 `node_modules` 完整。释放目录由部署账号持有，服务用户只读，禁止由应用写入自身代码。
2. 安装并审阅 `favor.service` 至 `/etc/systemd/system/favor.service`，核对 `/usr/bin/node` 的真实路径；执行 `systemctl daemon-reload`。新服务首次暂不启动，等待release切换。
3. 使用服务器上权限0600的MariaDB客户端配置文件执行 `mariadb-dump --defaults-extra-file=/受保护路径/db.cnf --single-transaction --routines --triggers favor > /受保护备份目录/迁移前.sql`。shell重定向前先设置 `umask 077`；检查退出状态和备份大小。不要把密码放在命令参数里。
4. 审阅并由root安装 `favor-release` 至 `/usr/local/sbin/favor-release`，仅向deploy授予此固定辅助程序的sudo权限。执行 `sudo -n /usr/local/sbin/favor-release <版本号>`；它自动备份数据库、迁移、原子切换、重启和健康检查，失败回切已验证旧版。首次失败停止服务并保留候选诊断。不要直接以root执行release内可由deploy修改的脚本。
5. 将 `nginx.conf.example` 改为实际域名与证书路径，使用单独配置文件，确保未覆盖既有站点。紧接着执行 `nginx -t`，仅成功后reload。外网仅开放80/443和受控SSH；应用不开放公网端口。为避免邀请令牌进入访问日志，模板关闭本站Nginx access log；应用日志保留路径和错误但省略查询参数。
6. 执行 `systemctl enable favor.service`，验证重启持久性。检查公网HTTPS页面、`/api/health`、刷新页面、注册登录、实际新增记录、退出再登录后记录仍在、家庭邀请和移除成员流程。检查浏览器控制台和 `journalctl -u favor.service`。
7. 实测RAM/swap、磁盘剩余空间，记录当前版本、已验证版本和备份位置。只有公网业务验证通过后，人工删除确认属于本项目的更旧release，保留当前版本及一个已验证的上一版本。脚本不会自动广泛删除目录。

初始结构采用幂等建表，个人账本唯一性和关联完整性在数据库中约束。后续schema变化须添加明确迁移，不应仅改 `CREATE TABLE IF NOT EXISTS` 期待升级既有表。

## 回滚与恢复

代码回滚只适用于数据库结构向后兼容的版本。停止写入，核对 `/var/www/mosshqq/favor/known-good` 指向的已验证目录，使用临时软链接和 `mv -Tf` 原子回切 `current`，重启服务，验证本机健康与公网业务。不要将未验证候选记为可用回滚点。

发布脚本不自动回滚数据库。数据库恢复前停止服务并单独备份当前库，确认恢复范围、备份时间和将丢失的新增数据。先在独立库执行：

```sh
mariadb --defaults-extra-file=/受保护路径/admin.cnf favor_restore_check < /受保护备份目录/迁移前.sql
```

`favor_restore_check` 应由管理员事先创建。核对用户、账本、成员、人物、事由、事件、记录数量，金额汇总、会话表、导入去重标识和外键；用只指向恢复库的本机临时应用验证登录和访问隔离。不要把临时应用发布到公网。恢复验证通过、获得生产切换授权后才恢复业务库或调整环境变量指向恢复库，再启动服务并验证。原库和备份在确认恢复成功前保留。

JSON备份适用于追加导入，不含账号与权限，不能代替完整MariaDB备份。定时数据库备份与异地保存须根据用户选择另行配置。
