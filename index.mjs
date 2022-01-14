import fetch from "node-fetch";
import Caritat from "caritat";
import { writeFile } from "fs/promises";
import snapshot from "@snapshot-labs/snapshot.js";
import config from "./config.json";

const Election = Caritat.Election;
const meek = Caritat.stv.meek;
const Ballot = Caritat.Ballot;

const snapshotAPI = "https://hub.snapshot.org/graphql";

const spaceID = config.spaceId;
const strategies = config.strategies;
const seatsToFill = config.seatsToFill;

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
  .map((proposal) => ({
    id: proposal.id,
    title: proposal.title,
    candidates: proposal.choices.slice(0, proposal.choices.length - 1), // remove the "no vote" choice
    end: proposal.end,
  }));

Promise.all(snapshotProposalsQuery.map(countElectionVotes))
  .then((results) =>
    Promise.all([
      writeFile(
        "finalresults.json",
        JSON.stringify(results.map((r) => r.details))
      ),
      writeFile(
        "resultlogs.json",
        JSON.stringify(results.map((r) => r.fullLog))
      ),
    ])
  )
  .then(() => console.log("done"));

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
              }
            }`,
      }),
    }).then((res) => res.json())
  ).data.votes.map((voter) => ({ address: voter.voter, choice: voter.choice }));

  const _voteWeights = await snapshot.utils.getScores(
    "ens.eth",
    strategies,
    "1",
    electionResultsQuery.map((voter) => voter.address)
  );
  const voteWeights = _voteWeights[0];

  electionResultsQuery.forEach(({ address, choice }) => {
    const choiceToSend = choice.map((c) => c.toString());
    election.addBallot(new Ballot(choiceToSend, voteWeights[address]));
  });

  const winnersCalculation = meek(election, { seats: seatsToFill });
  const winners = winnersCalculation
    .slice(0, seatsToFill)
    .map((candidate) => candidates[candidate - 1]);
  const _prevStandings =
    winnersCalculation.log[winnersCalculation.log.length - 1].candidates;

  console.log(title, "final standings", winners);

  const prevStandings = Object.keys(_prevStandings).map((candidate) => ({
    name: candidates[candidate - 1],
    votes: _prevStandings[candidate].votes,
    status: _prevStandings[candidate].status,
  }));

  return {
    details: {
      id,
      title,
      candidates,
      end,
      winners,
      prevStandings,
    },
    fullLog: winnersCalculation.log,
  };
}
