# AstrBot 微信适配器参考源码

来源：https://github.com/AstrBotDevs/AstrBot
检索时 master 树：68acac91b1ab92c2ac4cfd811c0898913a1391c8
文件路径：astrbot/core/platform/sources/weixin_oc/
源码通过 raw master 下载，随附上游 LICENSE。

server/wechat-client.js 为 Python HTTP 与文本发送逻辑的 JavaScript 迁移；保留 BrightBot 多实例路由，增加中止信号和正文校验。未迁移媒体处理。
