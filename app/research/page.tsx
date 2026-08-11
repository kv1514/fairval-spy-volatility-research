import type { Metadata } from "next";
import study from "./backtest-data.json";
import ResearchClient, { type StudyData } from "./ResearchClient";

export const metadata: Metadata = {
  title: "FairVal SPY Option Outcome Study",
  description: "A no-look-ahead replay testing whether large positive fair-value gaps later reached their original targets.",
};

export default function ResearchPage() {
  return <ResearchClient study={study as unknown as StudyData} />;
}
