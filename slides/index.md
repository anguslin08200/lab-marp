---
marp: true
theme: default
size: 16:9
paginate: true
title: 實驗室研究進度
author: 姓名
footer: 實驗室名稱 · Research Meeting
style: |
  /* Lab-wide appearance stays inside this single Markdown file. */
  section {
    --lab-accent: #174f78;
    font-family: "Microsoft JhengHei", "Segoe UI", sans-serif;
    font-size: 28px;
    line-height: 1.5;
    color: #243444;
    background-color: #ffffff;
    padding: 66px 76px;
    border-top: 8px solid var(--lab-accent);
  }
  /* Keep titles readable and leave space for the shared footer. */
  h1 { color: var(--lab-accent); font-size: 46px; margin-bottom: 26px; }
  h2 { color: var(--lab-accent); font-size: 38px; }
  strong { color: var(--lab-accent); }
  footer { font-size: 16px; color: #64748b; bottom: 22px; }
  section::after { font-size: 16px; color: #64748b; bottom: 22px; }
  /* Cover styling applies only to slides that opt into the cover class. */
  section.cover { color: #ffffff; background-color: #112f48; justify-content: center; }
  section.cover h1 { color: #ffffff; font-size: 56px; }
  section.cover strong { color: #ffffff; }
  section.cover footer, section.cover::after { color: #dbeafe; }
  /* Wide tables and formulas use the same restrained lab palette. */
  table { font-size: 24px; width: 100%; }
  th { background: #eaf2f8; }
  code { font-family: Consolas, monospace; font-size: 0.8em; }
---

<!-- _class: cover -->
<!-- Replace this decorative photo with your own lab photo if desired. -->
![bg right:42% brightness:0.65](assets/circuit.jpg)

# 實驗室研究進度

研究主題 / Project title

姓名 · 實驗室名稱
2026 / 10 / 10

<!-- Decorative image: Chris Ried, Unsplash, https://unsplash.com/photos/bN5XdU-bap4. This is a sample photo, not an experiment result. -->

---

# 研究目標

- **研究問題：** 在這裡寫下本次想回答的問題。
- **評估方法：** 說明實驗條件與比較基準。
- **本週進度：** 寫下完成的項目與待確認的問題。

<!-- Replace these prompts with your actual research content. -->

---

# 實驗條件與結果

| 項目 | 設定 / 結果 | 備註 |
| --- | --- | --- |
| 測試環境 | 待填寫 | 設備、版本或量測條件 |
| 比較基準 | 待填寫 | 參考方法或上週結果 |
| 主要指標 | 待填寫 | 數值、單位與誤差 |

**觀察：** 在這裡寫一個由資料支持的結論。

---

# 量測圖片

<!-- Put your own image in slides/assets and replace the path below. -->
![height:340px](assets/circuit.jpg)

圖片示例：請替換成波形、實驗設備照片或結果圖，並補上單位。

<!-- Sample image: Chris Ried, https://unsplash.com/photos/bN5XdU-bap4. -->

---

# 公式與後續工作

<!-- Marp renders LaTeX formulas using KaTeX in both preview and export. -->
$$
\mathrm{SNR}_{\mathrm{dB}} = 10\log_{10}\left(\frac{P_{\mathrm{signal}}}{P_{\mathrm{noise}}}\right)
$$

- 下一次實驗：待填寫。
- 尚待確認：待填寫。
- 討論事項：待填寫。
