//! Sandbox-side commands: `nest notify|emit|ask|expose|unexpose|whoami`. One `CliRequest` frame
//! to the guest agent's socket (`NEST_GUEST_SOCK`, default `/run/nest/guest.sock`), one
//! `CliResponse` back. Attribution comes from `NEST_AGENT_ID` (set on every hands exec).

use std::os::unix::net::UnixStream;

use nest_protocol::guest::{self, CliCommand, CliRequest, CliResponse, CliResult, Urgency, frame};
use nest_protocol::model::AgentId;

pub fn main(args: &[String]) -> i32 {
    let command = match parse(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nest: {e}");
            return 2;
        }
    };
    let agent_id = std::env::var("NEST_AGENT_ID").ok().map(AgentId);
    let sock = std::env::var("NEST_GUEST_SOCK").unwrap_or_else(|_| guest::GUEST_CLI_SOCKET.into());
    match request(&sock, CliRequest { agent_id, command }) {
        Ok(CliResult::Ok { data }) => {
            if !data.is_null() {
                println!("{data}");
            }
            0
        }
        Ok(CliResult::Answered { answer }) => {
            println!("{answer}");
            0
        }
        Ok(CliResult::Pending { question_id }) => {
            println!("pending: {question_id} (the answer will arrive as your next turn)");
            0
        }
        Ok(CliResult::Error { error }) => {
            eprintln!("nest: {}: {}", error.code, error.message);
            1
        }
        Err(e) => {
            eprintln!("nest: guest agent unavailable at {sock}: {e}");
            1
        }
    }
}

fn request(sock: &str, req: CliRequest) -> std::io::Result<CliResult> {
    let mut s = UnixStream::connect(sock)?;
    let body = serde_json::to_vec(&req).map_err(std::io::Error::other)?;
    frame::write_frame(&mut s, frame::Kind::Json, &body)?;
    let f = frame::read_frame(&mut s)?;
    let resp: CliResponse = serde_json::from_slice(&f.payload).map_err(std::io::Error::other)?;
    Ok(resp.result)
}

/// Parse `args` (including the subcommand) into a [`CliCommand`].
pub fn parse(args: &[String]) -> Result<CliCommand, String> {
    let (cmd, rest) = args.split_first().ok_or("missing command")?;
    let mut flags: Vec<(String, String)> = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if let Some(name) = a.strip_prefix("--") {
            let v = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
            flags.push((name.to_string(), v.clone()));
        } else {
            positional.push(a.clone());
        }
    }
    let flag = |n: &str| flags.iter().rev().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let text = || -> Result<String, String> {
        if positional.is_empty() { Err(format!("{cmd}: missing text")) } else { Ok(positional.join(" ")) }
    };
    let port = || -> Result<u16, String> {
        positional.first().and_then(|p| p.parse().ok()).ok_or_else(|| format!("{cmd}: missing or invalid port"))
    };
    Ok(match cmd.as_str() {
        "notify" => CliCommand::Notify {
            to: flag("to").unwrap_or_else(|| "captain".into()),
            message: text()?,
            urgency: match flag("urgency").as_deref() {
                None | Some("normal") => Urgency::Normal,
                Some("low") => Urgency::Low,
                Some("high") => Urgency::High,
                Some(u) => return Err(format!("unknown urgency {u}")),
            },
        },
        "emit" => CliCommand::Emit {
            event: positional.first().cloned().ok_or("emit: missing event")?,
            payload: match flag("payload") {
                Some(p) => serde_json::from_str(&p).map_err(|e| format!("--payload: {e}"))?,
                None => serde_json::Value::Null,
            },
        },
        "ask" => CliCommand::Ask {
            question: text()?,
            options: flags.iter().filter(|(k, _)| k == "option").map(|(_, v)| v.clone()).collect(),
            wait_s: flag("wait").map(|w| w.parse().map_err(|_| "--wait must be seconds")).transpose()?.unwrap_or(120).min(120),
        },
        "expose" => CliCommand::Expose { port: port()?, exposed: true },
        "unexpose" => CliCommand::Expose { port: port()?, exposed: false },
        "whoami" => CliCommand::Whoami {},
        other => return Err(format!("unknown command {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> CliCommand {
        parse(&s.split_whitespace().map(String::from).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn parses_commands() {
        assert_eq!(p("notify --to user build done"), CliCommand::Notify { to: "user".into(), message: "build done".into(), urgency: Urgency::Normal });
        assert_eq!(p("ask deploy? --option yes --option no --wait 30"), CliCommand::Ask { question: "deploy?".into(), options: vec!["yes".into(), "no".into()], wait_s: 30 });
        assert_eq!(p("expose 3000"), CliCommand::Expose { port: 3000, exposed: true });
        assert_eq!(p("emit progress --payload {\"pct\":50}"), CliCommand::Emit { event: "progress".into(), payload: serde_json::json!({"pct": 50}) });
        assert!(parse(&["expose".into(), "x".into()]).is_err());
    }

    #[test]
    fn round_trips_against_a_fake_guest_socket() {
        let dir = std::env::temp_dir().join(format!("nest-cli-guest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("guest.sock");
        let _ = std::fs::remove_file(&path);
        let l = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let f = frame::read_frame(&mut s).unwrap();
            let req: CliRequest = serde_json::from_slice(&f.payload).unwrap();
            assert!(matches!(req.command, CliCommand::Ask { .. }));
            let resp = CliResponse { result: CliResult::Pending { question_id: "ask_1".into() } };
            frame::write_frame(&mut s, frame::Kind::Json, &serde_json::to_vec(&resp).unwrap()).unwrap();
        });
        let r = request(path.to_str().unwrap(), CliRequest { agent_id: None, command: p("ask ok?") }).unwrap();
        assert_eq!(r, CliResult::Pending { question_id: "ask_1".into() });
        h.join().unwrap();
    }
}
