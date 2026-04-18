# 自动签到脚本

这是一个基于GitHub Actions的自动签到脚本，用于定时访问[某token网站](https://gpt.qt.cool/?ref=Ovm8wE)并完成签到操作。

## 功能特点

- 自动访问签到网站
- 自动输入密钥（从GitHub Secrets读取）
- 智能处理滑动验证码
- 完整的日志记录
- 异常处理和重试机制
- 支持定时执行和手动触发

## 项目结构

```
├── index.js              # 核心签到脚本
├── package.json          # 项目依赖配置
├── .github/
│   └── workflows/
│       └── checkin.yml   # GitHub Actions 工作流配置
├── .env.example          # 环境变量示例文件
└── README.md             # 项目说明文档
```

## 快速开始

### 1. Fork 本仓库

首先，将本仓库Fork到你自己的GitHub账号下。

### 2. 配置 GitHub Secrets

在你的仓库页面，点击 `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`，添加以下Secret：

- `CHECKIN_KEY`: 签到网站所需的密钥

### 3. 启用 GitHub Actions

在你的仓库页面，点击 `Actions` 标签，然后点击 `I understand my workflows, go ahead and enable them` 按钮启用GitHub Actions。

### 4. 手动触发签到（可选）

在你的仓库页面，点击 `Actions` -> `Auto Checkin` -> `Run workflow` 按钮可以手动触发一次签到。

## 配置说明

### 定时执行时间

默认情况下，脚本会在每天UTC时间0点（北京时间早上8点）执行。如果你想修改执行时间，可以编辑 `.github/workflows/checkin.yml` 文件中的 `cron` 表达式：

```yaml
schedule:
  - cron: '0 0 * * *'  # 每天UTC时间0点执行
```

cron表达式的格式为：`分 时 日 月 周`。例如：

- `0 0 * * *`: 每天UTC时间0点执行
- `0 8 * * *`: 每天UTC时间8点执行（北京时间下午4点）
- `30 7 * * *`: 每天UTC时间7点30分执行（北京时间下午3点30分）

### 环境变量

脚本支持以下环境变量：

- `CHECKIN_KEY`: 签到网站所需的密钥（必填）
- `LOG_LEVEL`: 日志级别，可选值：error, warn, info, verbose, debug, silly（默认：info）

## 注意事项

1. 本脚本仅用于学习和研究目的，请确保你的使用符合相关网站的服务条款。
2. 网站结构可能会发生变化，导致脚本无法正常工作。如果遇到问题，请检查并更新脚本中的选择器和逻辑。
3. 滑动验证码的处理可能不是100%成功，脚本包含了重试机制来提高成功率。

## 故障排除

### 脚本执行失败

1. 检查GitHub Actions的日志输出，查看具体的错误信息。
2. 确保你已经正确配置了 `CHECKIN_KEY` Secret。
3. 检查网站是否可以正常访问，以及页面结构是否发生了变化。

### 验证码处理失败

1. 网站可能更新了验证码机制，需要更新脚本中的验证码处理逻辑。
2. 尝试增加重试次数或调整滑动参数。

## 自定义和扩展

如果你需要修改脚本以适应其他网站，可以主要关注以下几个部分：

1. `CHECKIN_URL`: 签到网站的URL
2. 密钥输入框的选择器
3. 滑动验证码的处理逻辑
4. 签到按钮的选择器
5. 签到结果的判断逻辑

## 许可证

[MIT License](LICENSE)
