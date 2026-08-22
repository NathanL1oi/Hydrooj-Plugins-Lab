#include "testlib.h"
#include <bits/stdc++.h>
using namespace std;

using Answers = map<string, vector<string>>;

static string rokTrim(string s) {
    while (!s.empty() && isspace((unsigned char)s.front())) s.erase(s.begin());
    while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back();
    return s;
}

static string rokCompactLower(string s) {
    string result;
    for (unsigned char ch : s) {
        if (!isspace(ch)) result.push_back((char)tolower(ch));
    }
    return result;
}

static string rokReadLine(InStream& fin) {
    string line = fin.readLine();
    if (!line.empty() && line.back() == '\r') line.pop_back();
    return line;
}

static Answers readRichObjectiveAnswers(InStream& fin) {
    string magic = rokReadLine(fin);
    if (magic != "ROK1") quitf(_wa, "invalid rich objective answer format");

    string countLine = rokReadLine(fin);
    int count = 0;
    try {
        count = stoi(rokTrim(countLine));
    } catch (...) {
        quitf(_wa, "invalid answer count");
    }
    if (count < 0 || count > 10000) quitf(_wa, "invalid answer count");

    Answers answers;
    for (int i = 0; i < count; i++) {
        string header = rokReadLine(fin);
        size_t space = header.find(' ');
        if (space == string::npos) quitf(_wa, "broken answer header");

        string key = header.substr(0, space);
        int len = 0;
        try {
            len = stoi(header.substr(space + 1));
        } catch (...) {
            quitf(_wa, "invalid answer length");
        }
        if (key.empty() || key.size() > 64 || len < 0 || len > 262144) {
            quitf(_wa, "invalid answer entry");
        }

        string value(len, '\0');
        if (len) {
            for (int j = 0; j < len; j++) value[j] = fin.readChar();
        }
        char sep = fin.readChar();
        if (sep == '\r') {
            char next = fin.readChar();
            if (next != '\n') quitf(_wa, "missing answer separator");
        } else if (sep != '\n') {
            quitf(_wa, "missing answer separator");
        }
        answers[key].push_back(value);
    }
    while (!fin.seekEof()) fin.readChar();
    return answers;
}

static string one(const Answers& answers, const string& key) {
    auto it = answers.find(key);
    if (it == answers.end() || it->second.empty()) return "";
    return it->second.front();
}

static vector<string> many(const Answers& answers, const string& key) {
    auto it = answers.find(key);
    if (it == answers.end()) return {};
    vector<string> result = it->second;
    sort(result.begin(), result.end());
    return result;
}

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);

    // Hydro testlib checker arguments:
    // argv[1] = input, argv[2] = user output, argv[3] = standard output.
    Answers answers = readRichObjectiveAnswers(ouf);

    int score = 0;

    // q1: single choice, standard answer B, 50 points.
    if (rokTrim(one(answers, "q1")) == "B") score += 50;

    // q2: fill blank, accept endl or std::endl, 50 points.
    string q2 = rokCompactLower(one(answers, "q2"));
    if (q2 == "endl" || q2 == "std::endl") score += 50;

    // Multiple choice example:
    // if (many(answers, "q3") == vector<string>({"A", "D"})) score += 20;

    if (score == 100) quitf(_ok, "all answers are correct");
    if (score == 0) quitf(_wa, "no answer is correct");
    quitp(score / 100.0, "partial score: %d", score);
}
