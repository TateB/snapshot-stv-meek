import Caritat from "caritat";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import fetch from "node-fetch";
import config from "./config.json" assert { type: "json" };

const Election = Caritat.Election;
const meek = Caritat.stv.meek;
const Ballot = Caritat.Ballot;

const snapshotAPI = "https://hub.snapshot.org/graphql";

const spaceID = config.spaceId;
const seatsToFill = config.seatsToFill;

const args = process.argv.slice(2);
const asCurrent = args.includes("--current");

const currentList = ["1st", "2nd", "3rd"];

const snapshotProposalsQuery = (
  await fetch(snapshotAPI, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: `
    query {
      proposals (
        first: 100,
        skip: 0,
        where: {
          space_in: ["${spaceID}"],
        },
        orderBy: "created",
        orderDirection: desc
      ) {
        id
        title
        choices
        end
        state
      }
    }`,
    }),
  }).then((res) => res.json())
).data.proposals
  .filter((proposal) => proposal.title.toLowerCase().includes("election"))
  .splice(0, 4)
  .map((proposal) => ({
    id: proposal.id,
    title: proposal.title,
    candidates: proposal.choices, // remove the "no vote" choice
    end: proposal.end,
  }));

async function countElectionVotes({ id, title, candidates, end }) {
  console.log("COUNTING FOR", id);

  const election = new Election({
    minSeats: 0,
  });

  const electionResultsQuery = (
    await fetch(snapshotAPI, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: `
          query Votes {
              votes (
                first: 1000
                skip: 0
                where: {
                  proposal: "${id}"
                }
                orderBy: "created",
                orderDirection: desc
              ) {
                choice
                voter
                vp
              }
            }`,
      }),
    }).then((res) => res.json())
  ).data.votes.map((voter) => ({
    address: voter.voter,
    choice: voter.choice,
    weight: voter.vp,
  }));

  electionResultsQuery.forEach(({ choice, weight }) => {
    const choiceToSend = choice.map((c) => c.toString());
    election.addBallot(new Ballot(choiceToSend, weight));
  });

  const winnersCalculation = meek(election, { seats: seatsToFill });
  const winners = winnersCalculation
    .slice(0, seatsToFill)
    .map((candidate) => candidates[candidate - 1]);
  const _prevStandings =
    winnersCalculation.log[winnersCalculation.log.length - 1].candidates;

  console.log(title, "final standings", winners);

  const prevStandings = Object.keys(_prevStandings)
    .map((candidate) => ({
      name: candidates[candidate - 1],
      votes: _prevStandings[candidate].votes,
      status: _prevStandings[candidate].status,
    }))
    .sort((a, b) => b.votes - a.votes);

  const markdown = `### ${title.split("Steward")[0]} \n  ${prevStandings
    .map(
      (candidate, i) =>
        `* ${
          candidate.name + (candidate.status === "elected" ? " **" : " ")
        }(${candidate.votes.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} votes)${
          candidate.status === "elected"
            ? asCurrent
              ? ` - ${currentList[i]}**`
              : " - Elected**"
            : ""
        }\n`
    )
    .join("  ")}
      `;

  return {
    details: {
      id,
      title,
      candidates,
      end,
      winners,
      prevStandings,
      markdown,
    },
    fullLog: winnersCalculation.log,
  };
}

const main = async () => {
  if (!existsSync("./results")) {
    await mkdir("./results");
  }

  await Promise.all(snapshotProposalsQuery.map(countElectionVotes))
    .then((results) =>
      Promise.all([
        writeFile(
          "results/final.json",
          JSON.stringify(results.map((r) => r.details))
        ),
        writeFile(
          "results/logs.json",
          JSON.stringify(results.map((r) => r.fullLog))
        ),
        writeFile(
          "results/post.md",
          `# ${
            asCurrent ? "Current Standings" : "Final Standings"
          }\n*as of ${new Date().toUTCString()}*\n${results
            .map((r) => r.details.markdown)
            .join("\n")}`
        ),
      ])
    )
    .then(() => console.log("done"));
};

main();
