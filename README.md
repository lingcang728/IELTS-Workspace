# IELTS Workspace

Windows 上的雅思 Academic 机考练习软件。试卷和作答都在本机，不注册、不登录。

阅读和写作装好就能做。听力题目一并内置，音频不随安装包提供，需要自己导入。

网站：<https://ielts-workspace.pages.dev>

<p align="center">
  <img src="docs/assets/preview.png" alt="练习中心" width="88%" />
</p>

## 下载

系统：Windows 10 / 11，64 位。推荐安装版。

到 [Releases](https://github.com/lingcang728/IELTS-Workspace/releases/latest) 下载：

| 包 | 文件 | 数据放哪 |
| --- | --- | --- |
| 安装版（推荐） | `IELTS_Workspace_*_x64-setup.exe` | `%LOCALAPPDATA%\IELTS Workspace\data` |
| 便携版 | `IELTS_Workspace_*_x64.exe` | exe 同目录的 `data\` |

安装版支持应用内检查更新。便携版更新时会迁到安装版。

## 怎么用

1. 打开软件。Reading / Writing 直接开始。
2. Listening 若按钮是「添加音频」：导入本机 `mp3` / `m4a` / `wav`。每套必须是四个 Part/Section，也可以是文件夹或按册 ZIP。不再支持整轨校准。分册包在网站 [听力音频](https://ielts-workspace.pages.dev/#listening)。软件不会自己下载音频。
3. **练习**：可暂停、重听。**模考**：按机考纪律，听力只放一遍，不能拖进度条；听完后有 2 分钟检查。
4. 交卷后看对错。Listening / Reading 的 Band 是按公开换算表估算的，不是官方成绩。写作没有客观 Band。

来源栏里的「剑桥雅思 X · 本项目整理」表示题是本项目从教材整理出来的，不是剑桥官方软件。

## 数据

练习记录、笔记、导入的听力都在上面的数据目录里。卸载安装版时，LocalAppData 里的用户数据会留下。

除检查更新会访问 GitHub Release 外，软件不发网络请求，也没有遥测。

不内置 AI。需要讲解或批改时，软件只生成 prompt，你复制到自己已有的 ChatGPT / Gemini / Grok / Claude 网页里用。

## 版权

IELTS 是 Cambridge Assessment English、British Council、IDP 的商标。本项目与官方无关。

题库供个人学习，请使用正版剑桥教材。源码为 [MIT](LICENSE)。

有问题请开 [Issue](https://github.com/lingcang728/IELTS-Workspace/issues)。
