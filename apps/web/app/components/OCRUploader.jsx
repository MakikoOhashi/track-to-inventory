//app/components/OCRUploader.jsx
import React, { useState, useEffect, useCallback } from "react";
import {
  Card,
  DropZone,
  Text,
  Spinner,
  TextField,
  Button,
  Banner,
  Select,
  Link,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";

export default function OCRUploader({ shopId, onSaveSuccess }) {
  const { t, i18n } = useTranslation("common");
  const [file, setFile] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [ocrTextEdited, setOcrTextEdited] = useState(""); // 編集可能なOCRテキスト
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null); 
  const [fields, setFields] = useState({
    si_number: "",
    supplier_name: "",
    transport_type: "",
    items: []  // JSONBとして保存される配列
  });
  //const [error, setError] = useState("");
  const [ocrError, setOcrError] = useState("");
  const [aiError, setAiError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [isClient, setIsClient] = useState(false);
  const [usageInfo, setUsageInfo] = useState(null); // 使用状況情報を保存
  const [showManualForm, setShowManualForm] = useState(false);
  const demoImageUrl = "https://track-to-inventory.onrender.com/instruction_demo.png";

   // クライアント判定（SSR対策）
   useEffect(() => {
    setIsClient(true);
    // コンポーネント初期化時に使用状況を取得
    fetchUsageInfo();
  }, []);

    // 使用状況を取得する関数
    const fetchUsageInfo = async () => {
      try {
        const res = await fetch("/api/usage", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        
        if (res.ok) {
          const data = await res.json();
          setUsageInfo(data.usage);
        } else {
          // APIレスポンスがokでない場合もエラー表示
          setOcrError(t("ocrUploader.usageInfoFail", { message: `status: ${res.status}` }));
        }
      } catch (error) {
        console.error("使用状況の取得に失敗:", error);
      }
    };

    // OCR使用制限をチェックする関数
    const checkOCRLimit = async () => {
      try {
        const res = await fetch("/api/check-ocr-limit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        
        if (res.status === 401) {
          let data;
          try {
            data = await res.json();
          } catch {
            data = {};
          }
          throw new Error(data.error || "認証に失敗しました。アプリを再インストールしてください。");
        }
        
        if (res.status === 429) {
            let data;
          try {
            data = await res.json();
          } catch {
            data = {};
          }
          throw new Error(data.error || "OCR使用回数の月間上限に達しました。プランをアップグレードしてください。");
        }
        
        if (!res.ok) {
          let data;
        try {
          data = await res.json();
        } catch {
          data = {};
        }
        throw new Error(data.error || "OCR制限チェックに失敗しました");
      }
        
        return true;
      } catch (error) {
        throw error;
      }
    };

  const requestBackendOcr = useCallback(
  async (uploadedFile) => {
    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);
      const res = await fetch("/api/ocr-text", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        let msg = t("ocrUploader.ocrFailed");
        try {
          const data = await res.json();
          msg = data.error ? `${msg}: ${data.error}` : msg;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const data = await res.json();

      if (data.previewUrl) {
        setImageUrl(data.previewUrl);
      } else if (uploadedFile.type.startsWith("image/")) {
        setImageUrl(URL.createObjectURL(uploadedFile));
      } else {
        setImageUrl("");
      }

      return data.text || "";
    } catch (error) {
      setOcrError(error.message || t("ocrUploader.ocrFailed"));
      return "";
    }
  },
  [t]
  );

  // 画像アップロードハンドラー
  const handleDrop = useCallback(
    (_dropFiles, acceptedFiles, _rejectedFiles) => {
    const uploadedFile = acceptedFiles[0];
    setFile(uploadedFile);
    //setImageUrl(URL.createObjectURL(uploadedFile));
    setOcrText("");
    setOcrTextEdited("");
    setFields({ si_number: "", supplier_name: "", transport_type: "", items: []  });
    setOcrError("");
    setAiError("");
    setSaveError("");
    setImageUrl("");
     // ファイルがアップロードされた場合は手動入力フォームを非表示
    setShowManualForm(false);
  },
  []
  );

  // OCR実行
  const handleOcr = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setOcrError("");
    try {
      // ★ ここでOCR使用制限チェック
      await checkOCRLimit();

      let text = "";
      if (
        file.type === "application/pdf" ||
        file.name?.toLowerCase().endsWith(".pdf") ||
        file.type.startsWith("image/") ||
        file.type === "text/plain"
      ) {
        text = await requestBackendOcr(file);
      } else {
        setOcrError(t("ocrUploader.unsupportedFileType"));
        return;
      }
      setOcrText(text);
      setOcrTextEdited(text);
      setFields(extractFields(text));
    } catch (error) {
      // ★ ここでエラーメッセージを適切に設定
      console.error("OCR処理エラー:", error);
      setOcrError(error.message || t("ocrUploader.ocrFailed"));
    } finally {
      setLoading(false);
    }
  }, [file, requestBackendOcr, t]);

   // ★ 手動入力フォームを開く関数
   const handleOpenManualForm = () => {
    setShowManualForm(true);
    // フィールドをクリア（必要に応じて）
    setFields({ si_number: "", supplier_name: "", transport_type: "", items: [] });
    setOcrText("");
    setOcrTextEdited("");
    // ファイル関連もクリア
    setFile(null);
    setImageUrl("");
    setOcrError("");
    setAiError("");
    setSaveError("");
  };

    // ★ 手動入力フォームを閉じる関数
    const handleCloseManualForm = () => {
      setShowManualForm(false);
      setFields({ si_number: "", supplier_name: "", transport_type: "", items: [] });
    };


    // 商品リスト部分の抽出（必要に応じて正規表現を調整）
    function extractItems(text) {
      const lines = text.split("\n");
      const items = [];
      
      // より柔軟な商品行パターンマッチング
      for (let line of lines) {
        // 商品コード、商品名、数量、価格のパターン
        const patterns = [
          // OEP-SLEDII02 LEDII028 Chip LED Blue ... Use500.00
          /^([A-Z0-9-]+)\s+([A-Z0-9]+)\s+(.+?)\s+.*?Use(\d+\.?\d*)/i,
          // 一般的な商品行パターン
          /^(\S+)\s+(.+?)\s+(\d{1,3}(?:,\d{3})*)\s+.*?(\d+\.?\d*)/i
        ];
        
        for (let pattern of patterns) {
          const match = line.match(pattern);
          if (match) {
            const quantity = parseInt(match[3] ? match[3].replace(/,/g, "") : "1") || 1;
            // 数量が1以上であることを確認
            if (quantity >= 1) {
            items.push({
              name: match[3] ? match[3].trim() : match[2] ? match[2].trim() : "",
                quantity: quantity,
              product_code: match[1] || match[2] || "",
              unit_price: match[4] || ""
            });
            }
            break;
          }
        }
      }
      return items;
    }

    // 正規表現で仮抽出
  function extractFields(text) {
    return {
      si_number: text.match(/(?:INV(?:OICE)?(?:\s*(?:NO\.?|#|:|：))?|INVOICE NO\.?)[\s:：#-]*([A-Z0-9\/\-]+)/i)?.[1] ?? "",
      supplier_name: text.match(/(?:SUPPLIER|SHIPPER)[:： ]*([^\n]+)/i)?.[1]?.trim() ?? "",
      transport_type: text.match(/(?:SHIPMENT PER|SHIPPED PER|TRANSPORT TYPE)[:： ]*([^\n]+)/i)?.[1]?.trim() ?? "",
      items: extractItems(text),
    };
  }

   // フォーム編集
  const handleFieldChange = (key, val) => setFields(f => ({ ...f, [key]: val }));

  // 商品リスト編集（数量のバリデーション追加）
  const handleItemChange = (idx, key, value) => {
    setFields(f => ({
      ...f,
      items: f.items.map((item, i) => {
        if (i === idx) {
          const updatedItem = { ...item, [key]: value };
          // 数量の場合は正の数値のみ許可
          if (key === 'quantity') {
            const numValue = Number(value);
            if (numValue < 1) {
              updatedItem.quantity = 1; // 最小値1に設定
            } else {
              updatedItem.quantity = numValue;
            }
          }
          return updatedItem;
        }
        return item;
      })
    }));
  };

  const handleAddItem = () => {
    setFields(f => ({
      ...f,
      items: [...f.items, { name: "", quantity: 1 }]
    }));
  };

  const handleRemoveItem = (idx) => {
    setFields(f => ({
      ...f,
      items: f.items.filter((_, i) => i !== idx)
    }));
  };


   // AI補助（未入力項目のみAIで補完）
   const handleAiAssist = async () => {
    if (!ocrTextEdited.trim()) {
      setAiError(t("ocrUploader.emptyOcrText"));
      return;
    }
    
    setAiLoading(true);
    setAiError("");
    
    try {
      console.log("Sending to AI:", { text: ocrTextEdited, fields }); // デバッグ用
      
      const res = await fetch("/api/ai-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: ocrTextEdited,
          fields,
        }),
      });
      
      // ★ 401エラー（認証エラー）の専用ハンドリング
      if (res.status === 401) {
        let data;
        try {
          data = await res.json();
        } catch {
          data = {};
        }
        setAiError(data.error || "認証に失敗しました。アプリを再インストールしてください。");
        return;
      }
      
      // ★ 429エラー（使用回数制限）の専用ハンドリング
      let data;
      if (res.status === 429) {
        data = await res.json(); // ← 必ずここでawait！
        setAiError(data.error || "AI使用回数の月間上限に達しました。プランをアップグレードしてください。");
        return;
      }
      
      if (!res.ok) {
        let msg = `HTTP error! status: ${res.status}`;
        try {
          data = await res.json();
          msg = data.error ? `${msg}: ${data.error}` : msg;
        } catch (e) {
          // ignore
        }
        throw new Error(msg);
      }
      
      data = await res.json();
      console.log("AI Response:", data); // デバッグ用
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      let aiFields = {};
      try {
        aiFields = JSON.parse(data.result);
      } catch (parseError) {
        console.error("JSON parse error:", parseError, "Raw result:", data.result);
        setAiError(t("ocrUploader.aiParseFail"));
        return;
      }
      
      // 未入力項目のみ更新
      setFields(currentFields => {
        const updatedFields = { ...currentFields };
        
        // 各フィールドをチェックして未入力の場合のみ更新
        Object.entries(aiFields).forEach(([key, value]) => {
          if (key === 'items' && Array.isArray(value)) {
            // itemsは常に上書き
            updatedFields.items = value;
            }
           else if (key !== 'items') {
            if (!currentFields[key] || currentFields[key].trim() === "") {
              updatedFields[key] = value;
            }
          }
        });
        
        return updatedFields;
      });
      
      setAiResult(aiFields);
      
    } catch (error) {
      console.error("AI assist error:", error);
      setAiError(`AI補完に失敗しました: ${error.message}`);
    } finally {
      setAiLoading(false);
    }
  };
  
  const handleSaveToSupabase = async () => {
    // shopIdの必須チェック
    if (!shopId) {
      setSaveError(t("ocrUploader.noShopId"));
      return;
    }
    // バリデーション
    if (!fields.si_number) {
      setSaveError(t("ocrUploader.siRequired"));
      return;
    }

    try {
      setLoading(true);
      setSaveError("");

      // データの準備
      const shipmentData = {
        si_number: fields.si_number,
        supplier_name: fields.supplier_name,
        transport_type: fields.transport_type || null,
        items: fields.items || [],// ← JSONBカラムにそのまま保存
        
        status: t("ocrUploader.initialStatus"),
        etd: null,
        eta: null,
        delayed: false,
        clearance_date: null,
        arrival_date: null,
        memo: null,
        is_archived: false,
        shop_id: shopId, // ← 親コンポーネントから受け取ったshopIdを追加
        // created_at, updated_atフィールドは明示的に除外
      };

      // デバッグ：送信するデータをコンソールに出力
      console.log('📤 送信データ:', shipmentData);

      // API呼び出し
      const res = await fetch('/api/createShipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment: shipmentData }),
      });
      
      // デバッグ：レスポンスステータスを確認
      console.log('📡 レスポンスステータス:', res.status);
      console.log('📡 レスポンスOK:', res.ok);
      
      // レスポンステキストを取得（エラー詳細のため）
      const responseText = await res.text();
      console.log('📡 レスポンステキスト:', responseText);
      
      // HTTPステータスエラーをチェック
      if (!res.ok) {
       // 制限エラーの場合
      if (res.status === 403) {
        let json;
        try {
          json = JSON.parse(responseText);
        } catch (parseError) {
          // JSON解析に失敗した場合はデフォルトメッセージ
          setSaveError('SI登録件数の制限に達しました');
          return;
        }
        setSaveError(json.error || 'SI登録件数の制限に達しました');
        return;
      }
      throw new Error(`APIリクエストが失敗しました (ステータス: ${res.status})\nレスポンス: ${responseText}`);
    }
      
      // JSONとして解析を試行
      let json;
      try {
        json = JSON.parse(responseText);
      } catch (parseError) {
        console.error('❌ JSON解析エラー:', parseError);
        throw new Error(`APIレスポンスのJSON解析に失敗しました: ${responseText}`);
      }
      
      console.log('📥 APIレスポンス:', json);
      
      // APIからのエラーメッセージをチェック
      if (json.error) {
        console.error('❌ APIエラー:', json.error);
        throw new Error(`API処理エラー: ${json.error}`);
      }
      
      // 成功時の処理
      console.log('✅ 保存成功');
      alert('データが正常に保存されました！');
      
      // フォームリセット
      setFields({ si_number: "", supplier_name: "", transport_type: "", items: [] });
      setOcrText("");
      setOcrTextEdited("");
      setImageUrl("");
      setFile(null);
      setShowManualForm(false); // 手動入力フォームも非表示

      // 親コンポーネントのコールバック関数を呼び出し
      if (onSaveSuccess) {
        onSaveSuccess();
      }

    } catch (error) {
      console.error('❌ 保存エラーの詳細:', {
        エラーメッセージ: error.message,
        スタックトレース: error.stack,
        フィールドデータ: fields,
        OCRテキスト: ocrTextEdited,
        shopId: shopId
      });
      setSaveError(t("ocrUploader.saveFail", { message: error.message }));
    } finally {
      setLoading(false);
    }
  };

// クライアントでのみレンダリング
  if (!isClient) {
    return (
      <Card sectioned>
        <Spinner />
      </Card>
    );
  }

  // ステータスは英語キーで管理
  const STATUS_OPTIONS = [
    { label: t('modal.status.siIssued'), value: "siIssued" },
    { label: t('modal.status.scheduleConfirmed'), value: "scheduleConfirmed" },
    { label: t('modal.status.shipping'), value: "shipping" },
    { label: t('modal.status.customsClearance'), value: "customsClearance" },
    { label: t('modal.status.warehouseArrival'), value: "warehouseArrival" },
    { label: t('modal.status.synced'), value: "synced" },
  ];

  return (
    <Card sectioned>
      
        {/* タイトルを明示的に表示 */}
        <div style={{ marginBottom: '24px' }}>
          <Text as="h2" variant="headingLg">{t("ocrUploader.title")}</Text>
        </div>

       {/* ファイルアップロードセクション */}
      <div style={{ marginBottom: '24px' }}>
      <DropZone 
       
        accept="image/*,application/pdf" 
        onDrop={handleDrop}
        >
        {!file ? (
          <div style={{ textAlign: "center", paddingInlineStartadding: 20, width: "100%" }}>
          <Text variant="bodyMd" as="span">
          {t("ocrUploader.dropzoneText")}
          </Text>
        </div>
        ) : (
          <Text variant="bodyMd">{file.name}</Text>
        )}
      </DropZone>
      {/* public/instruction_demo.png へのリンク。public/はURLに含めず、/instruction_demo.png でOK */}
      <a
        href={demoImageUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: "13px",
          color: "#6d7175",
          textDecoration: "underline",
          marginTop: 8,
          display: "inline-block"
        }}
      >
        {t('ocr.testImageLabel')}
      </a>
      {file && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={handleOcr} 
          disabled={
            loading || 
            (usageInfo?.ocr && usageInfo.ocr.remaining <= 0 && usageInfo.ocr.limit !== Infinity)}>
          {t("ocrUploader.ocrButton")}
          </button>
          {loading && <Spinner size="small" />}
          </div>
          

          {/* OCR関連のエラー表示 */}
          {ocrError && (
            <div style={{ marginTop: 8 }}>
              <Text color="critical" variant="bodySm">{ocrError}</Text>
            </div>
          )}
          
          {usageInfo?.ocr && usageInfo.ocr.remaining <= 0 && usageInfo.ocr.limit !== Infinity && (
            <Text variant="bodySm" color="critical" style={{ marginTop: 8 }}>
              月間OCR使用回数の上限に達しています
            </Text>
          )}
        </div>
      )}
    </div>
      {/* ★ 手動入力ボタン（OCR制限時や任意で使用） */}
      {!showManualForm && (
        <div style={{ marginBottom: '24px' }}>
          <Button onClick={handleOpenManualForm}>
            {t("ocrUploader.manualInputButton")}
          </Button>
          <Text variant="bodySm" color="subdued" style={{ marginTop: 8 }}>
            {t("ocrUploader.manualInputDescription")}
          </Text>
        </div>
      )}

      {/* 画像＋OCRテキスト横並び または 手動入力フォーム */}
      {((imageUrl && (ocrText || loading)) || showManualForm) && (
        <div style={{ display: "flex", gap: 32, marginTop: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* 画像プレビュー手動入力時は非表示 */}
          {imageUrl && !showManualForm && (
          <div style={{ minWidth: 280, maxWidth: 400 }}>
            <Text variant="headingMd">{t("ocrUploader.uploadedImage")}</Text>
            <img
              src={imageUrl}
              alt="uploaded"
              style={{
                width: "100%",
                border: "1px solid #eee",
                borderRadius: 4,
                marginTop: 8,
                maxHeight: 400,
                objectFit: "contain"
              }}
            />
          </div>
          )}
              {/* OCR編集テキストエリア＋FORM */}
          <div style={{ flex: 1, minWidth: 320 }}>
            {/* 手動入力時のヘッダー */}
            {showManualForm && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <Text variant="headingMd">{t("ocrUploader.manualInputHeader")}</Text>
                <Button size="slim" onClick={handleCloseManualForm}>{t("ocrUploader.closeButton")}</Button>
              </div>
            )}

          {/* 手動入力フォーム */}
          {!showManualForm && (
            <>
          {/* OCR編集テキストエリア＋FORM */}
          
            <Text variant="headingMd">{t("ocrUploader.ocrResultTitle")}</Text>
            <TextField
              multiline={10}
              value={ocrTextEdited}
              onChange={setOcrTextEdited}
              autoComplete="off"
              placeholder={t("ocrUploader.ocrResultPlaceholder")}
              style={{ fontFamily: "monospace", marginTop: 8, minHeight: 180 }}
            />
            </>
          )}
            {/* 共通フォーム項目 */}
            <div style={{ marginTop: 16 }}>
            <TextField label={t("ocrUploader.siNumber")} value={fields.si_number} onChange={val => handleFieldChange("si_number", val)} autoComplete="off" />
            <TextField label={t("ocrUploader.supplierName")} value={fields.supplier_name} onChange={val => handleFieldChange("supplier_name", val)} autoComplete="off" />
            <TextField label={t("ocrUploader.transportType")} value={fields.transport_type} onChange={val => handleFieldChange("transport_type", val)} autoComplete="off" />
              {/* items入力欄 */}
              <div style={{ marginTop: 12 }}>
                <Text variant="headingSm">{t("ocrUploader.productList")}</Text>
                {fields.items && fields.items.length > 0 ? (
                  fields.items.map((item, idx) => (
                    <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                      <TextField
                        label={t("ocrUploader.productName")}
                        value={item.name || ""}
                        onChange={v => handleItemChange(idx, "name", v)}
                        autoComplete="off"
                        style={{ width: 160 }}
                      />
                      <TextField
                        label={t("ocrUploader.quantity")}
                        type="number"
                        value={item.quantity || ""}
                        onChange={v => {
                          const numValue = Number(v);
                          // 正の整数のみ許可（1以上）
                          if (numValue >= 1) {
                            handleItemChange(idx, "quantity", numValue);
                          }
                        }}
                        autoComplete="off"
                        min={1}
                        step={1}
                        style={{ width: 100 }}
                      />
                      <Button size="slim" destructive onClick={() => handleRemoveItem(idx)}>{t("ocrUploader.delete")}</Button>
                    </div>
                  ))
                ) : (
                  <Text color="subdued">{t("ocrUploader.noProductData")}</Text>
                )}
                <Button size="slim" onClick={handleAddItem} style={{ marginTop: 4 }}>
                  {t("ocrUploader.addProduct")}
                </Button>
              </div>
            </div>
            {/* アクションボタンとエラー表示セクション  */}
            <div style={{ marginTop: 16, display: "flex", gap: 12, flexDirection: "column", alignItems: "flex-start" }}>
               {/* AI補助セクション（手動入力時は非表示） */}
               {!showManualForm && (
              <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button
                onClick={handleAiAssist}
                disabled={aiLoading}
              >
                {t("ocrUploader.aiButton")}
              </Button>
              {usageInfo?.plan === 'free' && (
                <Text color="subdued" variant="bodySm" style={{ marginTop: 4 }}>
                  {t("ocrUploader.freePlanRestriction")}
                </Text>
              )}
                {aiLoading && <Spinner size="small" />}
              </div>
                {aiError && (
                  <div style={{ marginTop: 8 }}>
                  <Text color="critical" variant="bodySm" style={{ marginTop: 4 }}>{aiError}</Text>
                  </div>
                )}
              </div>
              )}

              {/* 保存ボタンセクション */}
              <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Button primary onClick={handleSaveToSupabase} disabled={!fields.si_number}>
                  {t("ocrUploader.saveButton")}
                </Button>
                {loading && <Spinner size="small" />}
                </div>
                {saveError && (
                  <div style={{ marginTop: 8 }}>
                  <Text color="critical" variant="bodySm" style={{ marginTop: 4 }}>{saveError}</Text>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

    </Card>
  );
}
