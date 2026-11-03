# 进行中的对话不被旧对话抢走

`syncCurrent` 在焦点会话 `running === true`、而 shell current 指向未运行的会话时直接返回；两边都在运行或都是空闲对话时仍跟随 current。修剪保留正在运行的窗格：成员列表短暂漏掉某会话时，只要它仍在运行，对应窗格不删，等真正结束后再按成员列表修剪。`focusOrOpenWorkspaceConversation` 看到焦点窗格的会话正在运行时，即使它还不算「已开始的工作区对话」也不替换。

**状态**：accepted
