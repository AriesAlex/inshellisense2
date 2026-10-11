// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import com.jediterm.terminal.*;
import com.jediterm.terminal.model.*;
import com.jediterm.terminal.emulator.JediEmulator;
import com.jediterm.core.util.TermSize;
import java.lang.reflect.Proxy;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

// Replay verify-terminal.ts recordings using the actual JetBrains terminal engine.
public class ReplayTerminal {
  static String normalize(String text) {
    return text.replace("\r", "").replaceAll("(?m) +$", "").stripTrailing();
  }

  public static void main(String[] args) throws Exception {
    Path recording = Path.of(args[0]);
    var display = (TerminalDisplay) Proxy.newProxyInstance(TerminalDisplay.class.getClassLoader(), new Class<?>[] {TerminalDisplay.class}, (proxy, method, values) -> {
      if (method.getReturnType() == boolean.class) return false;
      if (method.getReturnType() == int.class) return 0;
      if (method.getReturnType() == String.class) return "Replay";
      return null;
    });
    var style = new StyleState();
    var buffer = new TerminalTextBuffer(55, 12, style);
    var terminal = new JediTerminal(display, buffer, style);
    terminal.setTerminalOutput(new TerminalOutputStream() {
      public void sendBytes(byte[] bytes, boolean userInput) {}
      public void sendString(String text, boolean userInput) {}
    });
    var pending = new StringBuilder();
    for (String line : Files.readAllLines(recording)) {
      String[] parts = line.split(" ", 3);
      if (!parts[0].equals("output") && !pending.isEmpty()) {
        var emulator = new JediEmulator(new ArrayTerminalDataStream(pending.toString().toCharArray()), terminal);
        while (emulator.hasNext()) emulator.next();
        pending.setLength(0);
      }
      switch (parts[0]) {
        case "resize" -> terminal.resize(new TermSize(Integer.parseInt(parts[1]), Integer.parseInt(parts[2])), RequestOrigin.User);
        case "output" -> pending.append(new String(Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8));
        case "checkpoint" -> {
          String cursor = terminal.getCursorX() + "," + terminal.getCursorY();
          Path expectedCursor = recording.resolveSibling(parts[1] + ".cursor.txt");
          Path expectedScreen = recording.resolveSibling(parts[1] + ".viewport.txt");
          if (!cursor.equals(Files.readString(expectedCursor))) {
            throw new AssertionError(parts[1] + ": cursor " + cursor + " instead of " + Files.readString(expectedCursor));
          }
          if (!normalize(buffer.getScreenLines()).equals(normalize(Files.readString(expectedScreen)))) {
            throw new AssertionError(parts[1] + ": screen differs from xterm\n" + buffer.getScreenLines());
          }
          System.out.println("PASS: JediTerm " + parts[1] + " cursor=" + cursor);
        }
      }
    }
  }
}
