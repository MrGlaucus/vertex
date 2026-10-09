# 标签触发 Docker Hub 发布

工作流：`.github/workflows/build-docker-image.yml`。

## 配置 Secrets

在 GitHub 仓库 **Settings → Secrets and variables → Actions → Repository secrets** 添加：

| 名称 | 值 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 登录用户名，通常为 `mrglaucus` |
| `DOCKERHUB_TOKEN` | 对 `mrglaucus/vertex` 有推送权限的 Docker Hub Access Token |

镜像名称固定为 `mrglaucus/vertex`，不由登录用户名决定。可先在 Docker Hub 创建 `vertex` 仓库。

## 发布

先提交并推送当前修改，确保标签指向的提交包含工作流、测试、源码及 `docker/Dockerfile.local`。标签只打包对应提交，未提交的工作区修改不会进入镜像。

```sh
git push origin stable
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

示例假设修改已经提交，`v1.0.0` 尚不存在。无需创建 GitHub Release；推送标签即可触发。在 GitHub Actions 查看 `Publish Docker Image on Tag`。

| Git 标签 | 推送的镜像标签 |
| --- | --- |
| `v1.0.0` | `mrglaucus/vertex:v1.0.0`、`mrglaucus/vertex:latest` |
| `V1.0` | `mrglaucus/vertex:V1.0`、`mrglaucus/vertex:latest` |
| `1.0.1` | `mrglaucus/vertex:1.0.1`、`mrglaucus/vertex:latest` |
| `v1.1.0-beta.1` | `mrglaucus/vertex:v1.1.0-beta.1` |
| `test-20261009` | `mrglaucus/vertex:test-20261009` |

所有标签推送都会触发；标签必须也是有效 Docker 标签：首字符为英文字母、数字或下划线，其余可含点和连字符，总长度不超过 128，不能包含 `/` 或 `+`。

两段或三段数字版本（可带 `v` 或 `V` 前缀，如 `V1.0`、`v1.0.0`）更新 `latest`。这里的 latest 指最近完成发布的正式标签，不比较版本大小；重新发布旧正式版本也会更新它。Git 标签 `latest` 被禁止，该名字留给正式发布别名。

## 构建过程

1. 检出标签对应源码并验证 Secrets/标签。
2. Node 24 安装测试依赖，运行后端测试、前后端 ESLint。
3. 安装前端锁定依赖，生成主题并构建静态文件。
4. 使用 QEMU、Buildx 与 `docker/Dockerfile.local` 构建 AMD64/ARM64 镜像，一次推送所有标签。

显式使用 `context: .`，包含刚生成的前端文件，不重新克隆上游。Node 24 仅用于 CI 测试和前端；镜像运行环境来自现有 `lswl/vertex-base:latest`，生产原生依赖在镜像中正常安装。测试安装跳过原生编译，使用 Node 内置 SQLite 测试适配器。

流程配置参考 [Docker 官方 GitHub Actions 文档](https://docs.docker.com/build/ci/github-actions/multi-platform/)。原有分支推送构建已由本标签流程替换；`.gitlab-ci.yml` 未调整。

首次运行仍需在 GitHub 配置 Secrets 并推送包含这些修改的标签。当前本地校验不代表已完成 Docker Hub 发布。
