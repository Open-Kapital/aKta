//! Structured meeting minutes ("atas"): people roster, report generation via the
//! internal AI and a print window used to export the rendered HTML as PDF.

use std::time::Duration;

use log::{info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

use super::internal_llm;
use crate::state::AppState;

const GROUP_RESPONSIBLE: &str = "Time";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(900);
const SYSTEM_RESERVE_TOKENS: usize = 1500;
const MIN_OUTPUT_TOKENS: usize = 2048;
const MAX_OUTPUT_TOKENS: usize = 8192;
const MAX_REDUCE_ROUNDS: usize = 3;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Database error: {}", e)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Person {
    pub id: Option<i64>,
    pub name: String,
    pub initials: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReportRecord {
    pub meta: Option<Value>,
    pub report: Option<Value>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

#[tauri::command]
pub async fn akta_people_list(state: tauri::State<'_, AppState>) -> Result<Vec<Person>, String> {
    let rows =
        sqlx::query("SELECT id, name, initials FROM akta_people ORDER BY name COLLATE NOCASE")
            .fetch_all(state.db_manager.pool())
            .await
            .map_err(db_err)?;
    Ok(rows
        .iter()
        .map(|r| Person {
            id: Some(r.get("id")),
            name: r.get("name"),
            initials: r.get("initials"),
        })
        .collect())
}

#[tauri::command]
pub async fn akta_people_save(
    state: tauri::State<'_, AppState>,
    person: Person,
) -> Result<Person, String> {
    let name = person.name.trim().to_string();
    let initials = person.initials.trim().to_uppercase();
    if name.is_empty() || initials.is_empty() {
        return Err("Nome e iniciais são obrigatórios".to_string());
    }
    if initials.eq_ignore_ascii_case(GROUP_RESPONSIBLE) {
        return Err(format!(
            "\"{}\" é reservado para ações do time",
            GROUP_RESPONSIBLE
        ));
    }
    let pool = state.db_manager.pool();
    let result = match person.id {
        Some(id) => sqlx::query("UPDATE akta_people SET name = ?, initials = ? WHERE id = ?")
            .bind(&name)
            .bind(&initials)
            .bind(id)
            .execute(pool)
            .await
            .map(|_| id),
        None => sqlx::query("INSERT INTO akta_people (name, initials) VALUES (?, ?)")
            .bind(&name)
            .bind(&initials)
            .execute(pool)
            .await
            .map(|r| r.last_insert_rowid()),
    };
    match result {
        Ok(id) => Ok(Person {
            id: Some(id),
            name,
            initials,
        }),
        Err(e) if e.to_string().contains("UNIQUE") => {
            Err(format!("Já existe uma pessoa com as iniciais {}", initials))
        }
        Err(e) => Err(db_err(e)),
    }
}

#[tauri::command]
pub async fn akta_people_delete(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM akta_people WHERE id = ?")
        .bind(id)
        .execute(state.db_manager.pool())
        .await
        .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn akta_report_get(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<ReportRecord, String> {
    let row = sqlx::query(
        "SELECT meta, report, updated_at FROM akta_meeting_reports WHERE meeting_id = ?",
    )
    .bind(&meeting_id)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(db_err)?;
    let Some(row) = row else {
        return Ok(ReportRecord::default());
    };
    let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    Ok(ReportRecord {
        meta: parse(row.get("meta")),
        report: parse(row.get("report")),
        updated_at: row.get("updated_at"),
    })
}

async fn save_meta(pool: &SqlitePool, meeting_id: &str, meta: &Value) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO akta_meeting_reports (meeting_id, meta, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(meeting_id) DO UPDATE SET meta = excluded.meta, updated_at = excluded.updated_at",
    )
    .bind(meeting_id)
    .bind(meta.to_string())
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn akta_report_save_meta(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    meta: Value,
) -> Result<(), String> {
    save_meta(state.db_manager.pool(), &meeting_id, &meta).await
}

/// Most recent generated report of the same series, used for the "Referência" field.
#[tauri::command]
pub async fn akta_report_previous(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    serie: String,
) -> Result<Option<Value>, String> {
    if serie.trim().is_empty() {
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT meta FROM akta_meeting_reports
         WHERE meeting_id != ? AND report IS NOT NULL
           AND lower(trim(json_extract(meta, '$.serie'))) = lower(trim(?))
         ORDER BY json_extract(meta, '$.data') DESC LIMIT 1",
    )
    .bind(&meeting_id)
    .bind(&serie)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(db_err)?;
    Ok(row.and_then(|r| serde_json::from_str(&r.get::<String, _>("meta")).ok()))
}

#[tauri::command]
pub async fn akta_report_generate(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    meta: Value,
) -> Result<Value, String> {
    let pool = state.db_manager.pool().clone();
    save_meta(&pool, &meeting_id, &meta).await?;

    let transcript = load_transcript(&pool, &meeting_id).await?;
    if transcript.trim().is_empty() {
        return Err("A reunião não tem transcrição".to_string());
    }

    let config = internal_llm::load_config(&pool).await;
    let client = internal_llm::http_client(Some(REQUEST_TIMEOUT))?;
    let model = internal_llm::resolve_model(&client, &config).await;
    let api_key = config.api_key.as_deref().filter(|k| !k.trim().is_empty());
    let context = internal_llm::context_window(&client, api_key).await;
    let llm = Llm {
        client,
        model,
        api_key: api_key.map(str::to_string),
        context,
    };
    info!(
        "akta ata: generating report for {} (context {})",
        meeting_id, context
    );

    let participants = participants_from_meta(&meta);
    let header = meeting_header(&meta, &participants);
    let source = condense_if_needed(&llm, &header, transcript).await?;
    let report = llm.generate_report(&header, &source, &participants).await?;

    sqlx::query("UPDATE akta_meeting_reports SET report = ?, updated_at = datetime('now') WHERE meeting_id = ?")
        .bind(report.to_string())
        .bind(&meeting_id)
        .execute(&pool)
        .await
        .map_err(db_err)?;
    Ok(report)
}

/// Writes the rendered report to the app data dir and opens it in a window that
/// triggers the native print dialog ("Save as PDF").
#[tauri::command]
pub async fn akta_report_open_print<R: Runtime>(
    app: AppHandle<R>,
    html: String,
    file_name: String,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("akta")
        .join("print");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_name: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = if safe_name.is_empty() {
        "ata".to_string()
    } else {
        safe_name
    };
    let path = dir.join(format!("{}.html", safe_name));
    std::fs::write(&path, html).map_err(|e| e.to_string())?;

    let encoded = percent_encode(&path.to_string_lossy());
    let url = if cfg!(windows) {
        format!("http://asset.localhost/{}", encoded)
    } else {
        format!("asset://localhost/{}", encoded)
    };
    let url = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let label = format!("ata-print-{}", chrono::Utc::now().timestamp_millis());
    WebviewWindowBuilder::new(&app, label, WebviewUrl::CustomProtocol(url))
        .title(safe_name)
        .inner_size(920.0, 1000.0)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    if let Err(e) = window.print() {
                        warn!("akta ata: print failed: {}", e);
                    }
                });
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

async fn load_transcript(pool: &SqlitePool, meeting_id: &str) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT transcript, audio_start_time FROM transcripts WHERE meeting_id = ?
         ORDER BY COALESCE(audio_start_time, 0), timestamp",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let text: String = r.get("transcript");
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            let start: Option<f64> = r.get("audio_start_time");
            Some(match start {
                Some(s) => format!("[{:02}:{:02}] {}", (s as u64) / 60, (s as u64) % 60, text),
                None => text.to_string(),
            })
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn participants_from_meta(meta: &Value) -> Vec<(String, String)> {
    meta.get("participantes")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    let name = p.get("nome")?.as_str()?.trim().to_string();
                    let initials = p.get("iniciais")?.as_str()?.trim().to_string();
                    (!initials.is_empty()).then_some((name, initials))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn meeting_header(meta: &Value, participants: &[(String, String)]) -> String {
    let field = |k: &str| {
        meta.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let people = if participants.is_empty() {
        "(não informados)".to_string()
    } else {
        participants
            .iter()
            .map(|(n, i)| format!("- {} ({})", n, i))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "Reunião: {}\nÁrea: {}\nData: {}\nModalidade: {}\nParticipantes:\n{}",
        field("titulo"),
        field("area_nome"),
        field("data_extenso"),
        field("modalidade"),
        people
    )
}

fn estimate_tokens(text: &str) -> usize {
    text.chars().count() / 3 + 1
}

fn split_chunks(text: &str, max_tokens: usize) -> Vec<String> {
    let max_chars = max_tokens * 3;
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if !current.is_empty() && current.chars().count() + line.chars().count() > max_chars {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

fn output_budget(context: usize) -> usize {
    (context / 3).clamp(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
}

/// Turns long transcripts into detailed notes until they fit in a single request.
async fn condense_if_needed(llm: &Llm, header: &str, transcript: String) -> Result<String, String> {
    let limit = llm
        .context
        .saturating_sub(output_budget(llm.context) + SYSTEM_RESERVE_TOKENS)
        .max(1024);
    let mut text = transcript;
    for round in 0..MAX_REDUCE_ROUNDS {
        if estimate_tokens(&text) <= limit {
            return Ok(text);
        }
        let chunk_tokens = internal_llm::chunk_token_threshold(llm.context);
        let chunks = split_chunks(&text, chunk_tokens);
        info!(
            "akta ata: condensing round {} into {} chunks",
            round + 1,
            chunks.len()
        );
        let mut notes = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            let user = format!(
                "{}\n\nTrecho {} de {} da transcrição:\n{}",
                header,
                i + 1,
                chunks.len(),
                chunk
            );
            let note = llm
                .chat(NOTES_SYSTEM_PROMPT, &user, llm.context / 4, None)
                .await?;
            notes.push(format!("### Parte {}\n{}", i + 1, note.trim()));
        }
        text = notes.join("\n\n");
    }
    Ok(text)
}

struct Llm {
    client: Client,
    model: String,
    api_key: Option<String>,
    context: usize,
}

impl Llm {
    async fn chat(
        &self,
        system: &str,
        user: &str,
        max_tokens: usize,
        schema: Option<&Value>,
    ) -> Result<String, String> {
        let url = format!("{}/chat/completions", internal_llm::base_url());
        let mut body = json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            "temperature": 0.3,
            "max_tokens": max_tokens.max(256),
        });
        if let Some(schema) = schema {
            body["response_format"] = json!({
                "type": "json_schema",
                "json_schema": {"name": "ata", "strict": true, "schema": schema}
            });
        }
        let mut response = self.post(&url, &body).await?;
        if schema.is_some() && response.0.is_client_error() {
            warn!(
                "akta ata: server rejected response_format ({}), retrying without schema",
                response.0
            );
            body.as_object_mut().map(|o| o.remove("response_format"));
            response = self.post(&url, &body).await?;
        }
        let (status, text) = response;
        if !status.is_success() {
            return Err(format!("A IA interna respondeu {}: {}", status, text));
        }
        let json: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Resposta inválida da IA interna: {}", e))?;
        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default();
        Ok(strip_think(content))
    }

    async fn post(&self, url: &str, body: &Value) -> Result<(reqwest::StatusCode, String), String> {
        let response = internal_llm::with_auth(self.client.post(url), self.api_key.as_deref())
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Não foi possível falar com a IA interna: {}", e))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        Ok((status, text))
    }

    async fn generate_report(
        &self,
        header: &str,
        source: &str,
        participants: &[(String, String)],
    ) -> Result<Value, String> {
        let schema = report_schema(participants);
        let user = format!(
            "{}\n\nFormato da resposta (JSON):\n{}\n\nConteúdo da reunião:\n{}",
            header, REPORT_FORMAT_HINT, source
        );
        let max_tokens = output_budget(self.context)
            .min(self.context.saturating_sub(estimate_tokens(&user) + 500))
            .max(1024);
        let content = self
            .chat(REPORT_SYSTEM_PROMPT, &user, max_tokens, Some(&schema))
            .await?;
        parse_report(&content)
    }
}

fn strip_think(content: &str) -> String {
    let mut out = content.to_string();
    while let (Some(start), Some(end)) = (out.find("<think>"), out.find("</think>")) {
        if end < start {
            break;
        }
        out.replace_range(start..end + "</think>".len(), "");
    }
    out.trim().to_string()
}

fn parse_report(content: &str) -> Result<Value, String> {
    let start = content.find('{');
    let end = content.rfind('}');
    let (Some(start), Some(end)) = (start, end) else {
        return Err("A IA interna não devolveu uma ata em JSON".to_string());
    };
    let mut report: Value = serde_json::from_str(&content[start..=end])
        .map_err(|e| format!("A ata gerada veio em formato inválido: {}", e))?;
    if !report.get("secoes").map(Value::is_array).unwrap_or(false) {
        return Err("A ata gerada não tem seções".to_string());
    }
    if !report.get("resumo").map(Value::is_array).unwrap_or(false) {
        report["resumo"] = json!([]);
    }
    Ok(report)
}

fn report_schema(participants: &[(String, String)]) -> Value {
    let mut responsible: Vec<Value> = participants.iter().map(|(_, i)| json!(i)).collect();
    responsible.push(json!(GROUP_RESPONSIBLE));
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["resumo", "secoes"],
        "properties": {
            "resumo": {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "string"}},
            "secoes": {
                "type": "array", "minItems": 1,
                "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["titulo", "topicos"],
                    "properties": {
                        "titulo": {"type": "string"},
                        "topicos": {
                            "type": "array", "minItems": 1,
                            "items": {
                                "type": "object", "additionalProperties": false,
                                "required": ["titulo", "blocos", "acoes"],
                                "properties": {
                                    "titulo": {"type": "string"},
                                    "blocos": {
                                        "type": "array",
                                        "items": {
                                            "type": "object", "additionalProperties": false,
                                            "required": ["tipo", "texto", "itens"],
                                            "properties": {
                                                "tipo": {"enum": ["paragrafo", "lista", "decisao", "alerta", "info"]},
                                                "texto": {"type": "string"},
                                                "itens": {"type": "array", "items": {"type": "string"}}
                                            }
                                        }
                                    },
                                    "acoes": {
                                        "type": "array",
                                        "items": {
                                            "type": "object", "additionalProperties": false,
                                            "required": ["descricao", "responsaveis", "prazo"],
                                            "properties": {
                                                "descricao": {"type": "string"},
                                                "responsaveis": {"type": "array", "minItems": 1, "items": {"enum": responsible}},
                                                "prazo": {"type": "string"}
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

const REPORT_SYSTEM_PROMPT: &str = "Você é o secretário de reuniões da Open Kapital e redige atas formais em português do Brasil.

Regras:
- Escreva em terceira pessoa, com frases completas, tom corporativo e objetivo. Não invente fatos, números ou decisões.
- A gravação vem de um único microfone em reunião presencial: a transcrição não identifica quem fala. Deduza quem disse o quê pelo contexto (nomes citados, vocativos, \"eu fico com isso\", área de atuação).
- Refira-se às pessoas sempre pelas iniciais da lista de participantes (ex.: PV demonstrou...). Nunca use iniciais fora da lista.
- Organize a ata em 2 a 5 seções temáticas, cada uma com tópicos. Cada tópico tem blocos:
  - \"paragrafo\": texto corrido explicando a discussão (use \"texto\"; \"itens\" vazio);
  - \"lista\": detalhes em itens (use \"itens\"; \"texto\" vazio);
  - \"decisao\": uma decisão tomada pelo grupo;
  - \"alerta\": risco, ponto de atenção ou tema que ficou sem decisão;
  - \"info\": observação ou contexto relevante.
- \"acoes\": tarefas concretas combinadas no tópico, com responsáveis (iniciais) e prazo. Use \"A definir\" quando o prazo não for citado e \"Time\" quando a ação for de todos ou o responsável não puder ser identificado.
- O último tópico deve ser \"Próximos passos\" quando houver encaminhamentos.
- \"resumo\": 3 a 5 frases com as principais decisões e encaminhamentos.
- Ignore conversas paralelas e corrija erros evidentes de transcrição.
- Responda somente com o JSON, sem texto antes ou depois.";

const REPORT_FORMAT_HINT: &str = r#"{"resumo": ["..."], "secoes": [{"titulo": "...", "topicos": [{"titulo": "...", "blocos": [{"tipo": "paragrafo|lista|decisao|alerta|info", "texto": "...", "itens": ["..."]}], "acoes": [{"descricao": "...", "responsaveis": ["PV"], "prazo": "A definir"}]}]}]}"#;

const NOTES_SYSTEM_PROMPT: &str = "Você prepara notas detalhadas de um trecho de reunião para depois redigir a ata, em português do Brasil.
A transcrição vem de um único microfone e não identifica quem fala: deduza pelo contexto e use as iniciais da lista de participantes.
Liste, sem perder fatos, números, nomes e datas:
- temas discutidos e os argumentos de cada um;
- decisões tomadas;
- ações combinadas, com responsáveis (iniciais) e prazos;
- pontos que ficaram em aberto.
Responda apenas com as notas em tópicos.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encodes_paths_like_encode_uri_component() {
        assert_eq!(percent_encode("/a b/ç.html"), "%2Fa%20b%2F%C3%A7.html");
    }

    #[test]
    fn strips_think_blocks() {
        assert_eq!(strip_think("<think>abc</think>\n{\"a\":1}"), "{\"a\":1}");
    }

    #[test]
    fn parses_report_inside_fences() {
        let content = "```json\n{\"resumo\": [\"x\"], \"secoes\": []}\n```";
        let report = parse_report(content).unwrap();
        assert_eq!(report["resumo"][0], "x");
    }

    #[test]
    fn rejects_report_without_sections() {
        assert!(parse_report("{\"resumo\": []}").is_err());
    }

    #[test]
    fn schema_limits_responsibles_to_participants() {
        let schema = report_schema(&[("Pedro Ventura".into(), "PV".into())]);
        let allowed = &schema["properties"]["secoes"]["items"]["properties"]["topicos"]["items"]
            ["properties"]["acoes"]["items"]["properties"]["responsaveis"]["items"]["enum"];
        assert_eq!(allowed, &json!(["PV", "Time"]));
    }

    #[test]
    fn splits_long_text_on_lines() {
        let text = "linha um\n".repeat(100);
        let chunks = split_chunks(&text, 30);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.chars().count() <= 100));
    }
}
